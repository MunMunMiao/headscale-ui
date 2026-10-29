import { useStore as useFormStore } from "@tanstack/react-form";
import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { parse as parseJsonc } from "jsonc-parser";
import {
  CircleHelp,
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
  ShieldCheck,
  Tag,
  Trash2,
  Users,
  UserX,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { submitForm, useAppForm } from "@/components/app/form";
import { Notice } from "@/components/app/notice";
import MemberPicker, { type MemberOption } from "@/components/MemberPicker";
import AccessPolicyReview from "@/components/policy/AccessPolicyReview";
import AccessTagMaintenance from "@/components/policy/AccessTagMaintenance";
import IpRuleRow, { RuleRestrictions } from "@/components/policy/IpRuleRow";
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
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSession, useStore } from "@/composables/session-context";
import type { LifecycleScope } from "@/composables/tag-lifecycle-state";
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
  createGroup,
  createRule,
  createTagOwner,
  ensureTagDefinition,
  findOrphanReferences,
  isPolicyIdentityName,
  type PolicyDesignerState,
  type PolicyGroup,
  type PolicyRule,
  parseCommaList,
  parsePolicy,
  removeOrphanReferences,
  removeRuleById,
  serializePolicy,
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
import {
  observeTags,
  type TagObservation,
  tagOwnerDependencies,
} from "@/domain/tag-lifecycle";
import { i18n, useHeadscaleI18n } from "@/i18n";
import { productDescriptors } from "@/i18n/descriptors";
import { type CountMessage, formatCount } from "@/i18n/plural";
import { cn } from "@/lib/utils";
import { isNodeTag } from "@/utils/node";

// The add-rule form reuses the IP rule editor with a rule that is not in the policy yet.
const NEW_IP_RULE: IpRule = {
  ruleId: "new",
  source: "",
  destination: "",
  ports: "",
};

function validCustomPorts(value: string) {
  if (!value.trim() || value.trim() === "*") return true;
  return value.split(",").every((part) => {
    const token = part.trim();
    if (!/^\d+(?:-\d+)?$/.test(token)) return false;
    const [from, to = from] = token.split("-").map(Number);
    return from >= 0 && from <= to && to <= 65535;
  });
}

function PolicyReferenceHelp({ identity }: { identity: string }) {
  const { copy } = useProductCopy();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${copy.policyReferenceHelp} ${identity}`}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => event.stopPropagation()}
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
          </button>
        }
      />
      <PopoverContent
        className="max-w-[calc(100vw-2rem)] space-y-2 text-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <PopoverTitle>{copy.policyReferenceHelp}</PopoverTitle>
        <PopoverDescription>{copy.orphanReferenceTooltip}</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}

function tagIcon(tagName: string) {
  const lower = tagName.toLowerCase();
  if (lower.includes("server")) return Server;
  if (lower.includes("work") || lower.includes("laptop")) return Laptop;
  if (lower.includes("db") || lower.includes("data")) return Database;
  if (lower.includes("net") || lower.includes("router")) return Network;
  return Tag;
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

export default function AccessPage() {
  const {
    feedback,
    policy: policyStore,
    snapshot: snapshotStore,
    client,
    tagLifecycle,
    drafts,
  } = useSession();
  const navigate = useNavigate();
  const lifecycleState = useStore(tagLifecycle);
  const { returnTo } = lifecycleState;
  const deviceOrigin = returnTo?.source === "device";
  const { locale, meta } = useHeadscaleI18n();
  const { copy } = useProductCopy();
  const { snapshot, refreshErrors, refreshSnapshotInFlight } = useSnapshot();
  const { isActionPending, actionError, actionErrorKey, clearActionFeedback } =
    useActionFeedback();
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

  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      closeAccessEditors();
    };
  }, [closeAccessEditors]);
  const ownsPage = snapshotStore.captureSession();
  const pageScope = tagLifecycle.captureScope();

  // A dry run: no save ticket, no refresh, no draft or dirty-state change.
  const { mutate: runCheck } = useMutation({ skipRefresh: true });
  // A check result, passed or failed, only describes the draft text it was run on.
  const [checked, setChecked] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const checkNotification = useRef<string | null>(null);
  const checkGeneration = useRef(0);
  // Byte-identical to the text a save would submit. Without a payload the check button is
  // disabled, so the "null" text this yields is never sent.
  const draftText = JSON.stringify(policyPayload, null, 2);
  const { identity } = useStore(client);
  // A result must not carry over to another server or session.
  useEffect(() => {
    ++checkGeneration.current;
    setChecked(null);
  }, [identity]);
  async function checkDraft() {
    const generation = checkGeneration.current;
    const revision = policyStore.getSnapshot().editRevision;
    const isCurrent = () =>
      active.current &&
      generation === checkGeneration.current &&
      ownsPage() &&
      drafts.isCurrent() &&
      tagLifecycle.isCurrent(pageScope) &&
      policyStore.getSnapshot().editRevision === revision;
    if (
      !isCurrent() ||
      isActionPending("check-policy") ||
      isActionPending("save-policy") ||
      !policyStore.policyPayload
    )
      return;
    const notification = feedback.beginNotification({ isCurrent });
    if (checkNotification.current)
      feedback.toastManager.close(checkNotification.current);
    checkNotification.current = notification.id;
    setChecked(null);
    const text = JSON.stringify(policyStore.policyPayload, null, 2);
    const ok = await runCheck("check-policy", {
      endpoint: "checkPolicy",
      input: { policy: text },
    });
    if (!isCurrent()) return;
    setChecked({ text, ok });
    notification.publish({
      tone: ok ? "success" : "error",
      title: ok ? "product.policyCheckPassed" : "product.policyCheckFailed",
    });
  }
  const checkResult = checked?.text === draftText ? checked : null;

  const [tagSearchQuery, setTagSearchQuery] = useState("");
  const rawMaintenance = (
    useSearch({ strict: false }) as Record<string, unknown>
  ).maintenance;
  const queryMaintenance =
    typeof rawMaintenance === "string" && rawMaintenance.trim()
      ? rawMaintenance
      : null;
  const [maintenanceTag, setMaintenanceTag] = useState<string | null>(null);

  const visibleUsers = snapshot.users.filter(
    (user) => user.name !== "tagged-devices",
  );
  const knownUserIndex = PrincipalIndex.fromUsers(snapshot.users);

  const inventory = observeTags({
    policy: snapshot.policy,
    nodes: snapshot.nodes,
    preAuthKeys: snapshot.preAuthKeys,
    readState: snapshotStore.getSnapshot().segmentStatus,
  });
  const readbackPolicy = parsePolicy(snapshot.policy?.policy ?? "");
  const allTags = Array.from(
    new Set([
      ...listTagsFromState(policyDesignerState),
      ...inventory.tags.map((entry) => entry.tag),
      ...(returnTo?.managedTag ? [returnTo.managedTag] : []),
    ]),
  ).sort();

  interface TagMeta {
    tagName: string;
    displayName: string;
    owners: string[];
    accessors: TagAccessor[];
    deviceCount: number;
    // Observed resources are not declarations and are never silently renamed by a policy edit.
    deviceOnly: boolean;
    observation?: TagObservation;
    declaredInDraft: boolean;
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
      observation: inventory.tags.find((entry) => entry.tag === tagName),
      declaredInDraft: Boolean(ownerEntry),
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
  // A partial refresh cannot prove an account is gone. Missing groups only depend on the policy.
  const identityVerified =
    refreshSnapshotInFlight === 0 && !refreshErrors.identity;
  const orphanCandidates = findOrphanReferences(
    policyDesignerState,
    knownUserIndex,
  );
  const orphanRefs = orphanCandidates.filter(
    (ref) => ref.value.startsWith("group:") || identityVerified,
  );
  const hasUnverifiedReferences = orphanCandidates.length > orphanRefs.length;
  const ipRules = getIpRules(policyDesignerState);

  const hasGrants =
    Array.isArray(policyDesignerState.extras.grants) &&
    policyDesignerState.extras.grants.length > 0;
  const rawBaseline: unknown = parseJsonc(policyDraft, undefined, {
    allowTrailingComma: true,
  });
  const explicitAccess =
    rawBaseline !== null &&
    typeof rawBaseline === "object" &&
    (("acls" in rawBaseline && Array.isArray(rawBaseline.acls)) ||
      ("grants" in rawBaseline && Array.isArray(rawBaseline.grants)));
  // Missing sections imply the default allow rule; explicit empty arrays do not.
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

  const closeGeneration = useRef(0);
  const [tagRename, setTagRename] = useState<{
    from: string;
    to: string;
    revision: number;
    scope: LifecycleScope | null;
    generation: number;
    external: boolean;
    state: PolicyDesignerState;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Stamped with the edit revision it was raised at; any later edit, discard or load hides it.
  const [saveNotice, setSaveNotice] = useState<{
    kind: "not-sent" | "newer" | "context";
    revision: number;
  } | null>(null);
  const saving = isActionPending("save-policy") || isPolicySaving;
  function identityErrorText(
    issue: PolicyReferenceIssue,
    kind: "group" | "tag",
  ) {
    const messages = {
      "invalid-name":
        kind === "group" ? copy.teamNameInvalid : copy.labelNameInvalid,
      "name-conflict": copy.policyReferenceNameConflict,
      "entity-not-found": copy.policyReferenceEntityMissing,
      "unreadable-policy": copy.policyReadOnlyError,
      "unsupported-reference": copy.policyReferenceUnsupported,
    };
    return `${messages[issue.code]}${issue.paths.length ? ` ${issue.paths.join(", ")}` : ""}`;
  }
  // 基础名称校验不触碰策略；引用是否可改写仍由原 domain 在提交时判定。
  function nameIssue(
    kind: "group" | "tag",
    draft: string,
    current: string,
  ): PolicyReferenceIssue | null {
    const fullName =
      kind === "group" ? withGroupPrefix(draft) : withTagPrefix(draft);
    if (!fullName || fullName === current) return null;
    if (!isPolicyIdentityName(fullName, kind))
      return { code: "invalid-name", paths: [] };
    const taken = current
      ? aliases.has(fullName)
      : kind === "group"
        ? policyGroups.some((group) => group.name === fullName)
        : policyTagOwners.some((owner) => owner.tag === fullName);
    return taken ? { code: "name-conflict", paths: [] } : null;
  }

  useEffect(
    () => () => {
      ++closeGeneration.current;
    },
    [],
  );

  const tagDefaults = useMemo(() => {
    const state = policyStore.policyDesignerState;
    return {
      name: tagDetailOpen ? stripTagPrefix(tagDetailCurrent) : "",
      owners:
        state.tagOwners
          .find((owner) => owner.tag === tagDetailCurrent)
          ?.owners.map((owner) => owner.value) ?? [],
      accessors: getTagAccessors(state, tagDetailCurrent),
    };
  }, [policyStore, tagDetailOpen, tagDetailCurrent]);
  const teamDefaults = useMemo(
    () => ({
      name: teamDetailOpen ? stripGroupPrefix(teamDetailCurrent) : "",
      members:
        policyStore.policyDesignerState.groups
          .find((group) => group.name === teamDetailCurrent)
          ?.members.map((member) => member.value) ?? [],
    }),
    [policyStore, teamDetailOpen, teamDetailCurrent],
  );
  const tagForm = useAppForm({
    defaultValues: tagDefaults,
    onSubmitMeta: "done" as "name" | "done",
    validators: {
      onDynamic: ({ value }) => {
        const issue = nameIssue("tag", value.name, tagDetailCurrent);
        const fields: Record<string, string> = issue
          ? { name: identityErrorText(issue, "tag") }
          : {};
        const candidate = withTagPrefix(value.name);
        if (
          deviceOrigin &&
          candidate &&
          candidate !== tagDetailCurrent &&
          !isNodeTag(candidate)
        )
          fields.name = copy.policyManagementIncompatible;
        value.accessors.forEach((accessor, index) => {
          if (!validCustomPorts(accessor.customPorts))
            fields[`accessors[${index}].customPorts`] =
              copy.policyBufferedInvalid;
        });
        return Object.keys(fields).length ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value, formApi, meta }) => {
      if (value.name !== value.name.trim())
        formApi.setFieldValue("name", value.name.trim());
      if (!(await commitTagName(value.name))) return;
      if (meta === "done") {
        const valid = formApi.state.values.accessors.every((accessor) =>
          commitCustomPorts(accessor),
        );
        if (valid && !policyStore.getSnapshot().highRiskConfirmOpen)
          closeDialog("tag");
      }
    },
  });
  const teamForm = useAppForm({
    defaultValues: teamDefaults,
    onSubmitMeta: "done" as "name" | "done",
    validators: {
      onDynamic: ({ value }) => {
        const issue = nameIssue("group", value.name, teamDetailCurrent);
        return issue
          ? { fields: { name: identityErrorText(issue, "group") } }
          : undefined;
      },
    },
    onSubmit: ({ value, formApi, meta }) => {
      if (value.name !== value.name.trim())
        formApi.setFieldValue("name", value.name.trim());
      if (commitTeamName(value.name) && meta === "done") closeDialog("team");
    },
  });
  const tagValues = useFormStore(tagForm.store, (state) => state.values);
  const teamValues = useFormStore(teamForm.store, (state) => state.values);
  // 只记录哪些端口仍是临时输入，文本本身由表单管理；策略文档仍是业务草稿的唯一权威。
  const pendingPortDrafts = useRef(new Set<string>());
  useEffect(() => {
    ++closeGeneration.current;
    pendingPortDrafts.current.clear();
    tagForm.reset(tagDefaults);
  }, [tagForm, tagDefaults]);
  useEffect(() => {
    ++closeGeneration.current;
    teamForm.reset(teamDefaults);
  }, [teamForm, teamDefaults]);
  // rules 引用订阅策略变化，聚合 state getter 每次读取都会创建新对象。
  useEffect(() => {
    const drafts = tagForm.state.values.accessors;
    tagForm.setFieldValue(
      "accessors",
      getTagAccessors(policyStore.policyDesignerState, tagDetailCurrent).map(
        (accessor) => {
          const draft = drafts.find(
            (candidate) => candidate.who === accessor.who,
          );
          return draft && pendingPortDrafts.current.has(accessor.who)
            ? { ...accessor, customPorts: draft.customPorts }
            : accessor;
        },
      ),
      { dontUpdateMeta: true },
    );
    tagForm.setFieldValue(
      "owners",
      policyTagOwners
        .find((owner) => owner.tag === tagDetailCurrent)
        ?.owners.map((owner) => owner.value) ?? [],
      { dontUpdateMeta: true },
    );
  }, [tagForm, policyStore, policyRules, policyTagOwners, tagDetailCurrent]);
  useEffect(() => {
    teamForm.setFieldValue(
      "members",
      policyGroups
        .find((group) => group.name === teamDetailCurrent)
        ?.members.map((member) => member.value) ?? [],
      { dontUpdateMeta: true },
    );
  }, [teamForm, policyGroups, teamDetailCurrent]);

  function identityFieldError(
    kind: "tag" | "group",
    issue: PolicyReferenceIssue,
  ) {
    const error = identityErrorText(issue, kind);
    if (kind === "tag") {
      tagForm.setFieldMeta("name", (meta) => ({
        ...meta,
        isTouched: true,
        errorMap: { ...meta.errorMap, onDynamic: error },
      }));
    } else {
      teamForm.setFieldMeta("name", (meta) => ({
        ...meta,
        isTouched: true,
        errorMap: { ...meta.errorMap, onDynamic: error },
      }));
    }
  }

  function nameKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    kind: "tag" | "team",
  ) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitForm(kind === "tag" ? tagForm : teamForm, "name");
    }
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
      SERVICE_DEFS.filter((def) => def.id === id).map(
        (def) => copy[def.labelKey],
      ),
    );
    if (customPorts) parts.push(customPorts);
    return parts.length > 0 ? parts.join(" · ") : copy.svcCustomLabel;
  }

  function renderRuleDetails(rules: PolicyRule[]) {
    return rules.map((rule) => (
      <div key={rule.id} className="min-w-0 text-xs text-muted-foreground">
        <bdi dir="ltr">{rule.ports}</bdi>
        <RuleRestrictions extras={rule.extras} />
      </div>
    ));
  }

  function userPickerOptions(
    selectedValues: readonly string[],
    groupOrder: number,
  ): MemberOption[] {
    const opts: MemberOption[] = [];
    for (const user of visibleUsers) {
      const id = policyPrincipalForUser(user, snapshot.users);
      if (!id) continue;
      if (
        selectedValues.some((value) =>
          userMatchesPolicyValue(user, value, snapshot.users),
        )
      )
        continue;
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

  function buildAccessOptions(
    selectedValues: readonly string[],
  ): MemberOption[] {
    const opts: MemberOption[] = [];
    const takenGroups = new Set(
      selectedValues.map((value) => toPrincipal(value)),
    );
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

  const tagOwnerValues = tagValues.owners;
  const teamMembers = teamValues.members;
  const teamAccessRows = currentTeamMeta?.accessRows ?? [];
  const accessorOptionsForCurrentTag = buildAccessOptions(
    tagValues.accessors.map((a) => a.who),
  );
  const ownerOptionsForCurrentTag = buildAccessOptions(tagOwnerValues);
  const memberOptionsForCurrentTeam = userPickerOptions(teamMembers, 1);

  // The dialog's opening state: closing without saving reverts to it, and a dialog that was
  // never edited closes without a prompt even while the page holds unsaved edits.
  const dialogBase = useRef<{
    revision: number;
    state: PolicyDesignerState;
  } | null>(null);
  function markDialogOpened() {
    dialogBase.current = {
      revision: policyStore.getSnapshot().editRevision,
      state: policyStore.policyDesignerState,
    };
  }

  function openCreateTeam() {
    markDialogOpened();
    ++closeGeneration.current;
    setPolicyState({ teamDetailCurrent: "" });
    setPolicyState({ teamDetailOpen: true });
  }

  function openTeamDetailFor(group: PolicyGroup) {
    markDialogOpened();
    ++closeGeneration.current;
    setPolicyState({ teamDetailCurrent: group.name });
    setPolicyState({ teamDetailOpen: true });
  }

  function commitTeamName(name: string) {
    const fullName = withGroupPrefix(name);
    const current = policyStore.getSnapshot().teamDetailCurrent;
    const state = policyStore.policyDesignerState;
    // 空名称与未改名的失焦仍不是业务编辑。
    if (!fullName || current === fullName) return true;
    if (!current) {
      commitState(upsertGroup(state, createGroup(fullName, [])));
      setPolicyState({ teamDetailCurrent: fullName });
      return true;
    }
    const old = state.groups.find((group) => group.name === current);
    if (!old) return true;
    const result = renamePolicyGroup(state, old.id, fullName);
    if (!result.ok) {
      identityFieldError("group", result.issue);
      return false;
    }
    commitState(result.state);
    setPolicyState({ teamDetailCurrent: fullName });
    return true;
  }

  function changeTeamMembers(members: string[]) {
    const state = policyStore.policyDesignerState;
    const group = state.groups.find(
      (group) => group.name === policyStore.getSnapshot().teamDetailCurrent,
    );
    const next = group
      ? upsertGroup(state, { ...group, members: members.map(toMemberRef) })
      : state;
    teamForm.setFieldValue(
      "members",
      next.groups
        .find(
          (entry) => entry.name === policyStore.getSnapshot().teamDetailCurrent,
        )
        ?.members.map((member) => member.value) ?? [],
    );
    commitState(next);
  }

  function openCreateTag() {
    markDialogOpened();
    ++closeGeneration.current;
    setPolicyState({ tagDetailCurrent: "" });
    setPolicyState({ tagDetailOpen: true });
  }

  function openTagDetailFor(tagName: string) {
    markDialogOpened();
    ++closeGeneration.current;
    setPolicyState({ tagDetailCurrent: tagName });
    setPolicyState({ tagDetailOpen: true });
  }

  function tagNameMessage(message: string) {
    tagForm.setFieldMeta("name", (meta) => ({
      ...meta,
      isTouched: true,
      errorMap: { ...meta.errorMap, onDynamic: message },
    }));
  }

  async function verifyTagRename(
    from: string,
    to: string,
    scope: LifecycleScope | null,
    revision: number,
  ) {
    const fresh = await snapshotStore.refreshSegments([
      "policy",
      "fabric",
      "identity",
    ]);
    if (
      !tagLifecycle.isCurrent(scope) ||
      policyStore.getSnapshot().tagDetailCurrent !== from ||
      policyStore.getSnapshot().editRevision !== revision
    )
      return false;
    const latest = snapshotStore.getSnapshot();
    const observed = observeTags({
      ...latest.snapshot,
      readState: latest.segmentStatus,
    });
    if (
      !fresh ||
      observed.unknownSources.length ||
      latest.snapshot.policy?.policy !== policyStore.getSnapshot().policyDraft
    ) {
      tagNameMessage(copy.policyInventoryUnknown);
      return false;
    }
    const source = observed.tags.find((entry) => entry.tag === from);
    if (
      source?.nodeIds.length ||
      source?.keys.some(
        (entry) =>
          entry.registration === "available" ||
          entry.registration === "unknown",
      )
    ) {
      tagNameMessage(copy.policyRenameInUse);
      return false;
    }
    if (observed.tags.some((entry) => entry.tag === to)) {
      tagNameMessage(copy.policyMigrationOccupied);
      return false;
    }
    return true;
  }

  async function commitTagName(name: string) {
    const fullName = withTagPrefix(name);
    const current = policyStore.getSnapshot().tagDetailCurrent;
    const state = policyStore.policyDesignerState;
    if (!fullName || current === fullName) return true;
    if (!current) {
      commitState(ensureTagDefinition(state, fullName));
      setPolicyState({ tagDetailCurrent: fullName });
      return true;
    }
    const result = renamePolicyTag(state, current, fullName);
    if (!result.ok) {
      identityFieldError("tag", result.issue);
      return false;
    }
    if (tagRename?.from === current && tagRename.to === fullName) return false;
    const scope = tagLifecycle.captureScope();
    const revision = policyStore.getSnapshot().editRevision;
    const generation = closeGeneration.current;
    if (
      (await verifyTagRename(current, fullName, scope, revision)) &&
      generation === closeGeneration.current
    )
      setTagRename({
        from: current,
        to: fullName,
        scope,
        revision,
        generation,
        external: false,
        state: structuredClone(result.state),
      });
    return false;
  }

  const confirmTagRename =
    tagRename?.external && !renaming
      ? async () => {
          const reviewed = tagRename;
          setRenaming(true);
          try {
            if (
              !(await verifyTagRename(
                reviewed.from,
                reviewed.to,
                reviewed.scope,
                reviewed.revision,
              )) ||
              reviewed.generation !== closeGeneration.current
            ) {
              setTagRename(null);
              return;
            }
            // The reviewed transformation is valid only for this exact draft revision and scope.
            commitState(reviewed.state);
            setPolicyState({ tagDetailCurrent: reviewed.to });
            setTagRename(null);
          } finally {
            setRenaming(false);
          }
        }
      : undefined;

  function changeLabelManagers(owners: string[]) {
    const state = policyStore.policyDesignerState;
    const tag = policyStore.getSnapshot().tagDetailCurrent;
    const entry =
      state.tagOwners.find((owner) => owner.tag === tag) ??
      createTagOwner(tag, []);
    const next = upsertTagOwner(state, {
      ...entry,
      owners: owners.map(toMemberRef),
    });
    tagForm.setFieldValue(
      "owners",
      next.tagOwners
        .find((owner) => owner.tag === tag)
        ?.owners.map((owner) => owner.value) ?? [],
    );
    if (!next.tagOwners.some((owner) => owner.tag === tag)) {
      identityFieldError("tag", { code: "invalid-name", paths: [] });
      return;
    }
    commitState(next);
  }

  function addAccessor(value: string) {
    // The picker lists every policy group, and a group named "*" would grant access to everyone.
    if (value === "*") return;
    const tag = policyStore.getSnapshot().tagDetailCurrent;
    const next = setTagAccessor(
      policyStore.policyDesignerState,
      tag,
      value.trim(),
      "22",
    );
    tagForm.setFieldValue("accessors", (accessors) =>
      getTagAccessors(next, tag).map((accessor) => {
        const draft = accessors.find((entry) => entry.who === accessor.who);
        return draft && pendingPortDrafts.current.has(accessor.who)
          ? { ...accessor, customPorts: draft.customPorts }
          : accessor;
      }),
    );
    commitState(next);
  }

  function removeAccessor(who: string) {
    pendingPortDrafts.current.delete(who);
    tagForm.setFieldValue("accessors", (accessors) =>
      accessors.filter((accessor) => accessor.who !== who),
    );
    commitState(
      removeTagAccessor(
        policyStore.policyDesignerState,
        policyStore.getSnapshot().tagDetailCurrent,
        who,
      ),
    );
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

    applyAccessorServices(
      accessor.who,
      nextServices,
      accessor.customPorts.trim(),
    );
  }

  const [highRiskScope, setHighRiskScope] = useState<{
    who: string;
    target: string;
    ports: string;
  } | null>(null);

  function checkPortInput(who: string, custom: string) {
    const valid = validCustomPorts(custom);
    const index = tagForm.state.values.accessors.findIndex(
      (entry) => entry.who === who,
    );
    if (index < 0) return false;
    tagForm.setFieldMeta(`accessors[${index}].customPorts`, (meta) => ({
      ...meta,
      isTouched: true,
      errorMap: {
        ...meta.errorMap,
        onDynamic: valid ? undefined : copy.policyBufferedInvalid,
      },
    }));
    return valid;
  }

  function applyAccessorServices(
    who: string,
    services: ServiceId[],
    custom: string,
  ) {
    if (!checkPortInput(who, custom)) return;
    const ports = servicesToPortsString(services, custom);
    const tag = policyStore.getSnapshot().tagDetailCurrent;
    if (!ports) {
      removeAccessor(who);
      return;
    }
    const run = () => {
      const state = policyStore.policyDesignerState;
      const current = getTagAccessors(state, tag).find(
        (accessor) => accessor.who === who,
      );
      if (!current || current.readOnly) return;
      const next = setTagAccessor(state, tag, who, ports);
      // “全部端口”不序列化自定义文本，但恢复服务选择时仍要保留它。
      if (ports === "*") {
        pendingPortDrafts.current.add(who);
        tagForm.setFieldValue("accessors", (accessors) =>
          accessors.map((accessor) =>
            accessor.who === who
              ? { ...accessor, customPorts: custom }
              : accessor,
          ),
        );
      } else pendingPortDrafts.current.delete(who);
      commitState(next);
    };
    if (ports === "*" || who === "*") {
      setHighRiskScope({ who, target: tag, ports });
      setPolicyState({ pendingHighRiskAction: run, highRiskConfirmOpen: true });
    } else {
      run();
    }
  }

  function commitCustomPorts(accessor: TagAccessor) {
    if (!pendingPortDrafts.current.has(accessor.who) || accessor.readOnly)
      return true;
    const draft = accessor.customPorts.trim();
    if (!checkPortInput(accessor.who, draft)) return false;
    tagForm.setFieldValue("accessors", (accessors) =>
      accessors.map((entry) =>
        entry.who === accessor.who ? { ...entry, customPorts: draft } : entry,
      ),
    );
    const current = getTagAccessors(
      policyStore.policyDesignerState,
      policyStore.getSnapshot().tagDetailCurrent,
    ).find((entry) => entry.who === accessor.who);
    // 未改变有效端口的失焦不产生策略编辑，也不重复打开高风险确认。
    if (
      !current ||
      servicesToPortsString(current.services, current.customPorts) ===
        servicesToPortsString(accessor.services, draft)
    )
      return true;
    applyAccessorServices(accessor.who, accessor.services, draft);
    return true;
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

  const [removalRead, setRemovalRead] = useState<{
    tag: string;
    scope: LifecycleScope | null;
    observation: string;
    policy: string;
  } | null>(null);
  const removalReadGeneration = useRef(0);
  async function readTagRemoval(tag: string, explicit = false) {
    setRemovalRead(null);
    const scope = tagLifecycle.captureScope();
    const generation = ++removalReadGeneration.current;
    const isCurrent = () =>
      active.current &&
      ownsPage() &&
      tagLifecycle.isCurrent(scope) &&
      generation === removalReadGeneration.current;
    const notification = explicit
      ? feedback.beginNotification({ isCurrent })
      : null;
    const fresh = await snapshotStore.refreshSegments([
      "policy",
      "fabric",
      "identity",
    ]);
    if (!isCurrent()) return;
    if (!fresh) {
      notification?.publish({
        tone: "error",
        title: "product.feedbackRefreshFailed",
      });
      return;
    }
    const latest = snapshotStore.getSnapshot();
    const observed = observeTags({
      ...latest.snapshot,
      readState: latest.segmentStatus,
    });
    if (
      observed.unknownSources.length ||
      !latest.snapshot.policy ||
      latest.snapshot.policy.policy !== policyStore.getSnapshot().policyDraft
    )
      return;
    setRemovalRead({
      tag,
      scope,
      policy: latest.snapshot.policy.policy,
      observation: JSON.stringify(
        observed.tags.find((entry) => entry.tag === tag),
      ),
    });
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
    void readTagRemoval(tagName);
  }

  // The dialog has no trigger, so Base UI only ever asks to close it.
  function closePolicyRemovalDialog() {
    ++removalReadGeneration.current;
    setRemovalRead(null);
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
      ? (policyTagOwners.find((owner) => owner.id === pendingPolicyRemoval.id)
          ?.tag ?? withTagPrefix(pendingPolicyRemoval.label))
      : "";
  const removalPreview: PolicyReferenceResult | null =
    pendingPolicyRemoval?.kind === "group"
      ? removePolicyGroup(policyDesignerState, pendingPolicyRemoval.id)
      : pendingPolicyRemoval?.kind === "rule"
        ? {
            ok: true,
            state: removeRuleById(policyDesignerState, pendingPolicyRemoval.id),
          }
        : removalTag
          ? removePolicyTag(policyDesignerState, removalTag)
          : null;
  const removalNext = removalPreview?.ok ? removalPreview.state : null;
  // A scoped policy removal never changes existing nodes or keys.
  const removalDevices = removalTag ? deviceCountFor(removalTag) : 0;
  const removalObservation = inventory.tags.find(
    (entry) => entry.tag === removalTag,
  );
  const removalReady =
    !removalTag ||
    (removalRead?.tag === removalTag &&
      tagLifecycle.isCurrent(removalRead.scope) &&
      removalRead.policy === snapshot.policy?.policy &&
      removalRead.policy === policyDraft &&
      removalRead.observation === JSON.stringify(removalObservation) &&
      inventory.unknownSources.length === 0);
  // Known users are allowed after this full, explicitly policy-only review. Unknown sources are not zero.
  const confirmRemovePolicyItem =
    removalNext && removalReady
      ? () => {
          if (
            policyStore.getSnapshot().pendingPolicyRemoval?.id !==
            pendingPolicyRemoval?.id
          )
            return;
          commitState(removalNext);
          setPolicyState({ pendingPolicyRemoval: null });
          setPolicyState({ policyRemovalDialogOpen: false });
        }
      : undefined;
  const affected = (before: readonly unknown[], after: readonly unknown[]) =>
    before.filter(
      (entry) =>
        !after.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(entry),
        ),
    ).length;
  const extraImpact = (section: string) => {
    const before = policyDesignerState.extras[section];
    const after = removalNext?.extras[section];
    return affected(
      Array.isArray(before) ? before : [],
      Array.isArray(after) ? after : [],
    );
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

  const [ipDraftDirty, setIpDraftDirty] = useState(false);
  const [pendingIpEdit, setPendingIpEdit] = useState<string | null>(null);
  const dirtyIpInput = editingIpRuleId !== null && ipDraftDirty;
  const dirtyDialogInput = Boolean(
    (tagDetailOpen &&
      (tagValues.name !== stripTagPrefix(tagDetailCurrent) ||
        pendingPortDrafts.current.size > 0)) ||
    (teamDetailOpen && teamValues.name !== stripGroupPrefix(teamDetailCurrent)),
  );
  const ipNavigation = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      (dirtyIpInput || dirtyDialogInput) && current.pathname !== next.pathname,
    enableBeforeUnload: dirtyIpInput || dirtyDialogInput,
    withResolver: true,
  });
  function editIpRule(ruleId: string) {
    if (ruleId === editingIpRuleId) return;
    if (dirtyIpInput) setPendingIpEdit(ruleId);
    else setPolicyState({ editingIpRuleId: ruleId });
  }
  function cancelIpDiscard() {
    setPendingIpEdit(null);
    if (ipNavigation.status === "blocked") ipNavigation.reset();
  }
  function discardIpInput() {
    setIpDraftDirty(false);
    setPolicyState({ editingIpRuleId: pendingIpEdit });
    setPendingIpEdit(null);
    if (ipNavigation.status === "blocked") ipNavigation.proceed();
  }

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
      rules: [
        ...policyDesignerState.rules,
        createRule(source, destination, ports),
      ],
    });
    closeNewIpRule();
  }

  // A template that replaces rules (the open default) is applied only after a confirmation.
  const [pendingTemplate, setPendingTemplate] = useState<PolicyTemplate | null>(
    null,
  );
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
    if (pendingTemplate)
      commitState(applyTemplate(policyDesignerState, pendingTemplate));
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

  function showSaveNotice(kind: "not-sent" | "newer" | "context") {
    setSaveNotice({ kind, revision: policyStore.getSnapshot().editRevision });
  }

  const [publication, setPublication] = useState<{
    state: PolicyDesignerState;
    original: string;
    submitted: string;
    revision: number;
    scope: LifecycleScope | null;
    close: "tag" | "team" | null;
  } | null>(null);
  const [bufferedError, setBufferedError] = useState(false);

  async function reviewPublication(close: "tag" | "team" | null = null) {
    if (saving || policyStore.isPolicySaving) return;
    setSaveNotice(null);
    setBufferedError(false);
    if (dirtyIpInput) {
      setBufferedError(true);
      return;
    }
    if (tagDetailOpen) {
      await submitForm(tagForm, "name");
      if (
        !tagForm.state.isValid ||
        (withTagPrefix(tagForm.state.values.name) &&
          withTagPrefix(tagForm.state.values.name) !==
            policyStore.getSnapshot().tagDetailCurrent)
      ) {
        setBufferedError(true);
        return;
      }
      for (const accessor of tagForm.state.values.accessors)
        commitCustomPorts(accessor);
      if (policyStore.getSnapshot().highRiskConfirmOpen) return;
    }
    if (teamDetailOpen) {
      await submitForm(teamForm, "name");
      if (!teamForm.state.isValid) {
        setBufferedError(true);
        return;
      }
    }
    const current = policyStore.getSnapshot();
    const state = structuredClone(policyStore.policyDesignerState);
    if (!policyStore.isPolicyDirty || !policyStore.policyPayload) return;
    setPublication({
      state,
      original: current.policyDraft,
      submitted: JSON.stringify(serializePolicy(state), null, 2),
      revision: current.editRevision,
      scope: tagLifecycle.captureScope(),
      close,
    });
  }

  async function confirmPublication() {
    if (!publication || policyStore.isPolicySaving) return;
    const reviewed = publication;
    if (
      !tagLifecycle.isCurrent(reviewed.scope) ||
      reviewed.revision !== policyStore.getSnapshot().editRevision
    ) {
      setPublication(null);
      showSaveNotice("not-sent");
      return;
    }
    const context = {
      generation: closeGeneration.current,
      target: reviewed.close === "tag" ? tagDetailCurrent : teamDetailCurrent,
    };
    const isCurrentSession = snapshotStore.captureSession();
    const notification = feedback.beginNotification({
      isCurrent: () =>
        active.current &&
        isCurrentSession() &&
        drafts.isCurrent() &&
        tagLifecycle.isCurrent(reviewed.scope) &&
        context.generation === closeGeneration.current,
    });
    setPublication(null);
    const result = await savePolicyDocument("save-policy", reviewed.state);
    if (!isCurrentSession()) return;
    const current = policyStore.getSnapshot();
    const sameContext =
      context.generation === closeGeneration.current &&
      context.target ===
        (reviewed.close === "tag"
          ? current.tagDetailCurrent
          : current.teamDetailCurrent);
    if (!result.ok) {
      const outcome = feedback.actionOutcome("save-policy");
      if (
        outcome?.status !== "unknown" &&
        outcome?.status !== "possibly-applied" &&
        sameContext &&
        snapshotStore.getSnapshot().snapshot.policy?.policy !==
          reviewed.original
      )
        setPublication(reviewed);
      return;
    }
    ++checkGeneration.current;
    setChecked(null);
    clearActionFeedback("check-policy");
    if (checkNotification.current)
      feedback.toastManager.close(checkNotification.current);
    checkNotification.current = null;
    // A confirmed save cannot be undone by reverting the editor to its opening baseline.
    dialogBase.current = null;
    if (result.hasNewerEdits) showSaveNotice("newer");
    else if (!sameContext) showSaveNotice("context");
    else {
      notification.publish({
        tone: "success",
        title: "product.feedbackRequestConfirmed",
      });
      if (reviewed.close && !policyStore.isPolicyDirty)
        closeDialog(reviewed.close);
    }
    setPendingDialogClose(null);
  }

  const saveMessage = actionError("save-policy");
  const knownFileReadOnly =
    actionErrorKey("save-policy") === "policyUpdateDisabled";
  const saveNoticeText =
    saveNotice?.revision === editRevision
      ? saveNotice.kind === "not-sent"
        ? copy.feedbackRequestNotSent
        : saveNotice.kind === "newer"
          ? copy.policySavedNewerEdits
          : copy.policySaveContextChanged
      : "";
  const saveOutcome = feedback.actionOutcome("save-policy");
  const uncertainSave =
    saveOutcome?.status === "unknown" ||
    saveOutcome?.status === "possibly-applied";
  // The review and read-only card own their diagnosis; an uncertain write is only a notice.
  const showSaveError = Boolean(
    saveMessage && !knownFileReadOnly && !publication,
  );
  const showUncertainSave = uncertainSave && !knownFileReadOnly && !publication;
  const hasSaveFeedback = Boolean(
    saveNoticeText || showSaveError || showUncertainSave,
  );

  function renderSaveFeedback(prefix: "" | "dialog-") {
    return (
      <>
        {saveNoticeText && (
          <Notice tone="info">
            <p data-testid={`${prefix}policy-save-notice`}>{saveNoticeText}</p>
          </Notice>
        )}
        {showSaveError || showUncertainSave ? (
          <Notice tone={showUncertainSave ? "warning" : "error"}>
            {showSaveError && (
              <p data-testid={`${prefix}save-policy-error`}>{saveMessage}</p>
            )}
            {showUncertainSave && (
              <p data-testid={`${prefix}policy-save-uncertain`}>
                {copy.writeOutcomeVerifyInAccess}
              </p>
            )}
          </Notice>
        ) : null}
      </>
    );
  }

  type PendingClose = "tag" | "team" | null;
  const [pendingDialogClose, setPendingDialogClose] =
    useState<PendingClose>(null);
  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = useState(false);

  // "Done": the dialog's edits stay in the page draft, which the page-level Save publishes.
  function closeDialog(which: Exclude<PendingClose, null>) {
    ++closeGeneration.current;
    setPolicyState(
      which === "tag" ? { tagDetailOpen: false } : { teamDetailOpen: false },
    );
  }

  // X, Escape and the backdrop (the dialogs have no trigger, so Base UI only ever asks to close
  // them): edits made in this dialog need an explicit choice.
  function attemptDialogClose(which: Exclude<PendingClose, null>) {
    if (saving) return;
    const base = dialogBase.current;
    const buffered =
      which === "tag"
        ? tagForm.state.values.name !==
            (tagDetailCurrent ? stripTagPrefix(tagDetailCurrent) : "") ||
          pendingPortDrafts.current.size > 0
        : teamForm.state.values.name !==
          (teamDetailCurrent ? stripGroupPrefix(teamDetailCurrent) : "");
    if (
      buffered ||
      (isPolicyDirty &&
        (!base || base.revision !== policyStore.getSnapshot().editRevision))
    ) {
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
    if (ipNavigation.status === "blocked" && !dirtyIpInput)
      ipNavigation.proceed();
  }

  async function saveAndClose() {
    setUnsavedConfirmOpen(false);
    await reviewPublication(pendingDialogClose);
  }

  async function keepDraftAndClose(which: Exclude<PendingClose, null>) {
    const scope = tagLifecycle.captureScope();
    setUnsavedConfirmOpen(false);
    if (which === "tag") {
      await submitForm(tagForm, "done");
    } else {
      await submitForm(teamForm, "done");
    }
    setPendingDialogClose(null);
    if (ipNavigation.status === "blocked") {
      const current = policyStore.getSnapshot();
      const closed =
        which === "tag" ? !current.tagDetailOpen : !current.teamDetailOpen;
      if (!tagLifecycle.isCurrent(scope) || !closed) ipNavigation.reset();
      else if (!dirtyIpInput) ipNavigation.proceed();
    }
  }

  // History navigation must use the same explicit choices as closing a buffered editor.
  // opening this confirmation must not retrigger from its own state changes.
  useEffect(() => {
    if (ipNavigation.status === "blocked" && dirtyDialogInput && !saving)
      attemptDialogClose(tagDetailOpen ? "tag" : "team");
  }, [ipNavigation.status, dirtyDialogInput, saving]);

  const managedReturn = useRef<string | null>(null);
  // one opening per handoff, never reopen after the user closes it.
  useEffect(() => {
    if (
      queryMaintenance !== null ||
      returnTo?.status !== "managing" ||
      policyError ||
      managedReturn.current === returnTo.id
    )
      return;
    managedReturn.current = returnTo.id;
    if (returnTo.managedTag) openTagDetailFor(returnTo.managedTag);
  }, [returnTo?.id, policyError, queryMaintenance]);
  const { viewEpoch } = useStore(drafts);
  // identity/view/version changes retire confirmations but retain non-secret editor input.
  useEffect(() => {
    ++closeGeneration.current;
    setPublication(null);
    setTagRename(null);
    setMaintenanceTag(null);
  }, [identity, viewEpoch, lifecycleState.scope?.generation]);
  // A maintenance detour is independent of the original invitation/device return slot.
  useEffect(() => {
    setMaintenanceTag(queryMaintenance);
  }, [queryMaintenance]);

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
      maintenanceTag !== null ||
      publication !== null ||
      tagRename !== null ||
      discardConfirmOpen,
  );

  async function cleanupOrphanRefs() {
    setCleanupOrphanRefsOpen(false);
    const isCurrentSession = snapshotStore.captureSession();
    const generation = closeGeneration.current;
    const scope = tagLifecycle.captureScope();
    const isCurrent = () =>
      active.current &&
      isCurrentSession() &&
      tagLifecycle.isCurrent(scope) &&
      generation === closeGeneration.current;
    const notification = feedback.beginNotification({ isCurrent });
    if (orphanRefs.some((ref) => !ref.value.startsWith("group:"))) {
      const fresh = await snapshotStore.refreshSegments(["identity"]);
      if (!fresh)
        notification.publish({
          tone: "error",
          title: "product.feedbackRefreshFailed",
        });
    }
    if (!isCurrent()) return;
    const current = policyStore.policyDesignerState;
    const latest = snapshotStore.getSnapshot();
    const verified =
      !snapshotStore.isRefreshing && !latest.refreshErrors.identity;
    const confirmed = findOrphanReferences(
      current,
      PrincipalIndex.fromUsers(latest.snapshot.users),
    )
      .filter((ref) => ref.value.startsWith("group:") || verified)
      .filter((ref) =>
        orphanRefs.some(
          (candidate) =>
            candidate.kind === ref.kind &&
            candidate.containerId === ref.containerId &&
            candidate.value === ref.value,
        ),
      );
    commitState(removeOrphanReferences(current, confirmed));
  }

  async function returnToSource(record: NonNullable<typeof returnTo>) {
    const scope = tagLifecycle.captureScope();
    if (tagDetailOpen) {
      await submitForm(tagForm, "name");
      if (
        !tagForm.state.isValid ||
        withTagPrefix(tagForm.state.values.name) !==
          policyStore.getSnapshot().tagDetailCurrent
      )
        return;
      if (
        !tagForm.state.values.accessors.every(commitCustomPorts) ||
        policyStore.getSnapshot().highRiskConfirmOpen
      )
        return;
    }
    if (teamDetailOpen) {
      await submitForm(teamForm, "name");
      if (!teamForm.state.isValid) return;
    }
    if (
      !tagLifecycle.isCurrent(scope) ||
      tagLifecycle.getSnapshot().returnTo?.id !== record.id ||
      !tagLifecycle.requestReturn(record.id)
    )
      return;
    const to =
      record.source === "invite"
        ? "/invites"
        : record.source === "member-invite"
          ? "/members"
          : "/devices";
    void navigate({ to });
  }

  function renderReturnContext() {
    if (!returnTo) return null;
    const source =
      returnTo.source === "device"
        ? `${copy.devicesTitle} · ${returnTo.nodeId}`
        : returnTo.source === "member-invite"
          ? copy.membersTitle
          : returnTo.source === "setup"
            ? copy.devicesTitle
            : copy.invitesTitle;
    return (
      <aside
        className="grid gap-2 rounded-md border p-3 text-sm"
        data-testid="tag-management-context"
      >
        <p>
          {i18n._(productDescriptors.policyManageContext.id, {
            tag: returnTo.managedTag || copy.deviceLabelsSection,
            source,
          })}
        </p>
        {isPolicyDirty && (
          <p className="text-xs text-muted-foreground">
            {copy.policyManageDraftWarning}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          data-testid="tag-management-return"
          // Submit validates the buffered name; avoid a blur-driven reflow between pointer down and click.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void returnToSource(returnTo)}
        >
          {copy.policyManageReturn}
        </Button>
      </aside>
    );
  }

  function renderMaintenance() {
    return (
      maintenanceTag && (
        <AccessTagMaintenance
          readOnly={Boolean(policyError) || knownFileReadOnly}
          tag={maintenanceTag}
          onClose={() => setMaintenanceTag(null)}
          onEdit={(tag) => {
            setMaintenanceTag(null);
            openTagDetailFor(tag);
          }}
          onPrepare={(tag) => {
            commitState(
              ensureTagDefinition(policyStore.policyDesignerState, tag),
            );
            setMaintenanceTag(null);
            openTagDetailFor(tag);
          }}
        />
      )
    );
  }

  function renderTagObservation(tag: TagMeta) {
    const observation = tag.observation;
    const definition = observation?.definition ?? "undeclared";
    const original = readbackPolicy.tagOwners.find(
      (entry) => entry.tag === tag.tagName,
    );
    const change =
      !original && tag.declaredInDraft
        ? "added"
        : original && !tag.declaredInDraft
          ? "removed"
          : original &&
              JSON.stringify(original.owners.map((owner) => owner.value)) !==
                JSON.stringify(tag.owners)
            ? "changed"
            : null;
    return (
      <div
        className="mt-2 grid gap-1 text-xs text-muted-foreground"
        data-testid={`tag-observation-${tag.tagName}`}
      >
        <span>
          {definition === "declared"
            ? copy.policyReadbackDefinition
            : definition === "unknown"
              ? copy.policyDefinitionUnknown
              : copy.policyDefinitionAbsent}
        </span>
        {change && (
          <span
            data-testid={`tag-draft-state-${tag.tagName}`}
            data-state={change}
          >
            {
              {
                added: copy.policyDraftAdded,
                changed: copy.policyDraftChanged,
                removed: copy.policyDraftRemoved,
              }[change]
            }
          </span>
        )}
        <div className="flex flex-wrap gap-1">
          {observation?.sources.map((source) => (
            <Badge key={source} variant="outline">
              {
                {
                  definition: copy.policyDeclaredSource,
                  node: copy.policyObservedNodes,
                  key: copy.policyObservedKeys,
                  reference: copy.policyObservedReferences,
                }[source]
              }
            </Badge>
          ))}
        </div>
        {!!observation?.keys.length && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-auto min-h-8 whitespace-normal text-start"
            data-testid={`tag-invites-${tag.tagName}`}
            onClick={(event) => {
              event.stopPropagation();
              void navigate({ to: "/invites", search: { tag: tag.tagName } });
            }}
          >
            {copy.policyViewInvites} ({observation.keys.length})
          </Button>
        )}
      </div>
    );
  }

  function renderOwnerDependencies(tag: string) {
    const paths = tagOwnerDependencies(policyDesignerState, tag);
    return (
      <section
        className="grid gap-2 text-xs text-muted-foreground"
        data-testid="tag-owner-dependencies"
      >
        <h3 className="font-medium text-foreground">
          {copy.policyOwnerDependencies}
        </h3>
        <p>{copy.policyDependencyDisclaimer}</p>
        <ul className="grid gap-1">
          {paths.map((dependency) => (
            <li key={JSON.stringify(dependency.path)}>
              <bdi dir="auto">{dependency.path.join(" → ")}</bdi>
              {(dependency.cycle || dependency.missing) && ` · ${copy.unknown}`}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (policyError) {
    const fileMode = policyError === POLICY_FILE_MODE_WITHOUT_PATH;
    return (
      <section className="space-y-3 sm:space-y-5" dir={meta.dir}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              {copy.resourceAccessTitle}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy.resourceAccessSubtitle}
            </p>
          </div>
          <Button size="sm" data-testid="save-policy" disabled>
            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            {copy.policyPublishAll}
          </Button>
        </div>
        <Notice
          tone={fileMode ? "info" : "error"}
          title={copy.policyReadOnlyTitle}
        >
          <p data-testid="policy-read-only-notice">
            {policyBlockedMessage(copy, policyError)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {copy.policyReadOnlyAssignment}
          </p>
        </Notice>
        {renderReturnContext()}
        <div className="grid gap-3 sm:grid-cols-2">
          {tagsWithMeta.map((tag) => (
            <Card
              key={tag.tagName}
              className="p-3"
              data-testid={`tag-card-${tag.tagName}`}
            >
              <h2>
                <bdi dir="auto">{tag.tagName}</bdi>
              </h2>
              {renderTagObservation(tag)}
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                data-testid={`tag-maintenance-${tag.tagName}`}
                onClick={() => setMaintenanceTag(tag.tagName)}
              >
                {copy.policyMaintenance}
              </Button>
            </Card>
          ))}
        </div>
        {renderMaintenance()}
      </section>
    );
  }
  return (
    <section className="space-y-3 sm:space-y-5" dir={meta.dir}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{copy.resourceAccessTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {copy.resourceAccessSubtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              !policyPayload ||
              isActionPending("check-policy") ||
              isActionPending("save-policy")
            }
            onClick={() => void checkDraft()}
          >
            {isActionPending("check-policy") ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {copy.checkPolicy}
          </Button>
          <Button
            size="sm"
            data-testid="save-policy"
            disabled={
              !policyPayload || !isPolicyDirty || saving || knownFileReadOnly
            }
            onClick={() => void reviewPublication()}
          >
            {isActionPending("save-policy") ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            )}
            {copy.policyPublishAll}
          </Button>
        </div>
      </div>

      {!tagDetailOpen && !teamDetailOpen && renderReturnContext()}
      <p
        className="rounded-md border p-3 text-sm text-muted-foreground"
        data-testid="policy-access-baseline"
        data-mode={explicitAccess ? "explicit" : "implicit"}
      >
        {explicitAccess ? copy.policyExplicitAccess : copy.policyImplicitAccess}
      </p>
      {renderMaintenance()}
      {knownFileReadOnly && (
        <Notice tone="warning" title={copy.policyReadOnlyTitle}>
          <p data-testid="policy-known-read-only">{copy.policyKnownReadOnly}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {copy.policyReadOnlyAssignment}
          </p>
        </Notice>
      )}
      {!tagDetailOpen && !teamDetailOpen && renderSaveFeedback("")}
      {bufferedError && (
        <p
          className="text-sm text-destructive"
          data-testid="policy-buffered-error"
        >
          {copy.policyBufferedInvalid}
        </p>
      )}
      {publication && (
        <AccessPolicyReview
          original={publication.original}
          submitted={publication.submitted}
          latest={snapshot.policy?.policy}
          error={saveMessage}
          issues={inventory.referenceIssues}
          disabled={saving}
          onConfirm={() => void confirmPublication()}
          onCancel={() => setPublication(null)}
        />
      )}

      {checkResult?.ok && (
        <Notice tone="success">
          <p data-testid="policy-check-passed">{copy.policyCheckPassed}</p>
        </Notice>
      )}

      {checkResult && actionError("check-policy") && (
        <Notice tone="error" title={copy.policyCheckFailed}>
          <p data-testid="check-policy-error">{actionError("check-policy")}</p>
        </Notice>
      )}

      {hasGrants && (
        <Notice tone="info">
          <p data-testid="grants-preserved-notice">
            {copy.grantsPreservedHint}
          </p>
        </Notice>
      )}

      {openAccessWarnings.length > 0 && (
        <div data-testid="open-access-banner">
          <Notice tone="warning" title={copy.openAccessBannerTitle}>
            <p className="text-xs">
              {pluralize(openAccessWarnings.length, "openAccessWarnings")}
            </p>
            <ul className="mt-2 grid gap-1 text-xs">
              {openAccessWarnings.map((warning) => (
                <li key={warning.ruleId} className="break-all">
                  {copy.source}: <bdi dir="ltr">{warning.source}</bdi> →{" "}
                  {copy.destination}: <bdi dir="ltr">{warning.destination}</bdi>{" "}
                  · {copy.ports}: <bdi dir="ltr">{warning.ports}</bdi>
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      {allowsNothing && (
        <div data-testid="deny-all-banner">
          <Notice tone="warning" title={copy.denyAllBannerTitle}>
            <p className="text-xs">{copy.denyAllBannerBody}</p>
          </Notice>
        </div>
      )}

      {hasUnverifiedReferences && (
        <Notice tone="warning">
          <p data-testid="identity-unverified-notice">
            {copy.policyIdentityUnverified}
          </p>
        </Notice>
      )}

      {orphanRefs.length > 0 && (
        <div data-testid="orphan-ref-banner">
          <Notice tone="warning" title={copy.orphanRefBannerTitle}>
            <p className="text-xs">
              {pluralize(orphanRefs.length, "orphanReferences")}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-auto min-h-8 whitespace-normal text-start"
              data-testid="cleanup-orphan-refs"
              onClick={() => setCleanupOrphanRefsOpen(true)}
            >
              <Eraser className="h-4 w-4" aria-hidden="true" />
              {pluralize(orphanRefs.length, "cleanupOrphans")}
            </Button>
          </Notice>
        </div>
      )}

      {isEmptyState ? (
        <div
          className="rounded-md border bg-card p-6"
          data-testid="resource-access-empty"
        >
          <div className="text-center">
            <h2 className="text-lg font-semibold">
              {copy.resourceAccessEmptyTitle}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy.resourceAccessEmptyHint}
            </p>
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
            <Button
              data-testid="empty-create-team"
              onClick={() => openCreateTeam()}
            >
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
              <Users
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              {copy.teamsSection}
              <Badge variant="secondary" className="ms-1">
                {policyGroups.length}
              </Badge>
            </h2>
            <Button
              size="sm"
              data-testid="new-team"
              onClick={() => openCreateTeam()}
            >
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
                        <Badge
                          key={member.value}
                          variant="outline"
                          className="text-xs"
                        >
                          <bdi dir="auto">{whoDisplayLabel(member.value)}</bdi>
                        </Badge>
                      ))}
                      {team.group.members.length > 4 && (
                        <Badge variant="outline" className="text-xs">
                          {pluralize(
                            team.group.members.length - 4,
                            "moreItems",
                          )}
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
              <Tag
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
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
            <Button
              size="sm"
              data-testid="new-device-label"
              onClick={() => openCreateTag()}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {copy.newDeviceLabel}
            </Button>
          </div>

          {allTags.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed bg-background/50 px-4 py-6 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                {copy.noDeviceLabelsYet}
              </p>
              <p className="mt-1 text-xs">{copy.noDeviceLabelsHint}</p>
            </div>
          ) : filteredTagsWithMeta.length === 0 ? (
            <div
              className="mt-3 flex flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-background/50 px-4 py-6 text-sm text-muted-foreground"
              data-testid="tag-search-empty"
            >
              <p>{copy.noDeviceLabelsMatch}</p>
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
                          <bdi dir="auto">{t.displayName}</bdi>
                        </button>
                        <p className="text-xs text-muted-foreground">
                          {pluralize(t.deviceCount, "devicesTagged")}
                        </p>
                        {t.deviceOnly &&
                          t.observation?.sources.length === 1 &&
                          t.observation.sources[0] === "node" && (
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

                  {renderTagObservation(t)}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    data-testid={`tag-maintenance-${t.tagName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMaintenanceTag(t.tagName);
                    }}
                  >
                    {copy.policyMaintenance}
                  </Button>
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
                            <li
                              key={a.who}
                              className="flex items-center gap-1.5"
                            >
                              <Badge
                                variant="outline"
                                className={cn([
                                  "inline-flex items-center gap-1 text-xs break-all",
                                  isOrphanValue(a.who)
                                    ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                    : "",
                                ])}
                              >
                                {isOrphanValue(a.who) && (
                                  <UserX
                                    className="h-3 w-3 shrink-0"
                                    aria-hidden="true"
                                  />
                                )}
                                <bdi dir="auto">{whoDisplayLabel(a.who)}</bdi>
                                {isOrphanValue(a.who) && (
                                  <PolicyReferenceHelp identity={a.who} />
                                )}
                              </Badge>
                              <div className="min-w-0 text-xs text-muted-foreground">
                                · {serviceSummary(a.services, a.customPorts)}
                                {renderRuleDetails(
                                  policyRules.filter((rule) =>
                                    a.ruleIds.includes(rule.id),
                                  ),
                                )}
                              </div>
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
                          {copy.policyEmptyOwners}
                        </p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {t.owners.slice(0, 3).map((owner) => (
                            <Badge
                              key={owner}
                              variant={
                                isOrphanValue(owner) ? "outline" : "secondary"
                              }
                              className={cn([
                                "inline-flex items-center gap-1 text-xs break-all",
                                isOrphanValue(owner)
                                  ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                  : "",
                              ])}
                            >
                              {isOrphanValue(owner) && (
                                <UserX
                                  className="h-3 w-3 shrink-0"
                                  aria-hidden="true"
                                />
                              )}
                              <bdi dir="auto">{whoDisplayLabel(owner)}</bdi>
                              {isOrphanValue(owner) && (
                                <PolicyReferenceHelp identity={owner} />
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
            <p className="mt-1 text-xs text-muted-foreground">
              {copy.ipRulesSectionHint}
            </p>
          </div>
          <Button
            ref={addIpRuleButton}
            size="sm"
            variant="outline"
            data-testid="add-ip-rule"
            onClick={() => editIpRule(NEW_IP_RULE.ruleId)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.addIpRule}
          </Button>
        </div>

        <div className="mt-3 grid gap-1">
          {ipRules.length === 0 && editingIpRuleId !== NEW_IP_RULE.ruleId && (
            <p className="text-xs text-muted-foreground italic">
              {copy.noIpRules}
            </p>
          )}
          {ipRules.map((rule) => (
            <IpRuleRow
              key={rule.ruleId}
              rule={rule}
              onDirtyChange={setIpDraftDirty}
              onEditStart={() => editIpRule(rule.ruleId)}
              onEditCancel={() => setPolicyState({ editingIpRuleId: null })}
              onRemove={() => requestRemoveIpRule(rule)}
              onUpdate={(patch) => onUpdateIpRule(rule.ruleId, patch)}
              isEditing={editingIpRuleId === rule.ruleId}
            />
          ))}
          {editingIpRuleId === NEW_IP_RULE.ruleId && (
            <IpRuleRow
              rule={NEW_IP_RULE}
              onDirtyChange={setIpDraftDirty}
              onEditCancel={closeNewIpRule}
              onUpdate={addIpRule}
              isEditing
            />
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p
          data-testid="policy-normalization-notice"
          className="text-xs text-muted-foreground"
        >
          {copy.policyNormalizationNotice}
        </p>
        <Button
          size="sm"
          data-testid="save-policy-bottom"
          disabled={
            !policyPayload || !isPolicyDirty || saving || knownFileReadOnly
          }
          onClick={() => void reviewPublication()}
        >
          {saving ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
          )}
          {copy.policyPublishAll}
        </Button>
      </div>

      <AlertDialog
        open={
          pendingIpEdit !== null ||
          (ipNavigation.status === "blocked" &&
            dirtyIpInput &&
            !dirtyDialogInput &&
            !unsavedConfirmOpen)
        }
        onOpenChange={cancelIpDiscard}
      >
        <AlertDialogContent data-testid="discard-ip-draft-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.unsavedChangesTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.discardIpDraftBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="discard-ip-draft-cancel">
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="discard-ip-draft-confirm"
              onClick={discardIpInput}
            >
              {copy.discardDialogChanges}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={tagDetailOpen}
        onOpenChange={() => attemptDialogClose("tag")}
      >
        <DialogContent
          className="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
          data-testid="tag-detail-dialog"
        >
          <tagForm.AppForm>
            <tagForm.Form className="flex min-h-0 flex-1 flex-col">
              <DialogHeader className="shrink-0 px-6 py-4 border-b">
                <DialogTitle className="break-all leading-snug">
                  {copy.tagDetailDialogTitle}
                  {currentTagMeta && (
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      {currentTagMeta.displayName}
                    </span>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {copy.tagDetailDialogSubtitle}
                </DialogDescription>
                {currentTagMeta && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pluralize(currentTagMeta.deviceCount, "devicesTagged")}
                  </p>
                )}
              </DialogHeader>

              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
                <div>
                  <tagForm.AppField
                    name="name"
                    listeners={{
                      onChange: ({ fieldApi }) => {
                        ++closeGeneration.current;
                        fieldApi.setMeta((meta) => ({
                          ...meta,
                          errorMap: { ...meta.errorMap, onDynamic: undefined },
                        }));
                      },
                      onBlur: () => {
                        void submitForm(tagForm, "name");
                      },
                    }}
                  >
                    {(field) => (
                      <div className="flex items-end gap-2">
                        <field.TextField
                          id="tag-name-input"
                          data-testid="tag-name-input"
                          label={copy.deviceLabelName}
                          description={copy.deviceLabelNameHint}
                          fieldClassName="flex-1"
                          placeholder={copy.deviceLabelNameHint}
                          readOnly={currentTagMeta?.deviceOnly}
                          onKeyDown={(event) => nameKeyDown(event, "tag")}
                        />
                        {!tagDetailCurrent && (
                          <tagForm.SubmitButton
                            type="button"
                            variant="outline"
                            disabled={!field.state.value.trim()}
                            data-testid="tag-name-confirm"
                            onClick={() => {
                              void submitForm(tagForm, "name");
                            }}
                          >
                            {copy.confirm}
                          </tagForm.SubmitButton>
                        )}
                      </div>
                    )}
                  </tagForm.AppField>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {copy.policyTagRenameScope}
                  </p>
                  {currentTagMeta && renderTagObservation(currentTagMeta)}
                  {currentTagMeta && !currentTagMeta.declaredInDraft && (
                    <div
                      className="mt-2 grid gap-2"
                      data-testid="tag-device-only-hint"
                    >
                      {isPolicyIdentityName(tagDetailCurrent, "tag") ? (
                        <Button
                          type="button"
                          variant="outline"
                          data-testid="tag-declare"
                          disabled={
                            deviceOrigin && !isNodeTag(tagDetailCurrent)
                          }
                          onClick={() =>
                            commitState(
                              ensureTagDefinition(
                                policyStore.policyDesignerState,
                                tagDetailCurrent,
                              ),
                            )
                          }
                        >
                          {copy.policyDeclareTag}
                        </Button>
                      ) : (
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          {copy.policyIncompatibleTag}
                        </p>
                      )}
                      {(!isPolicyIdentityName(tagDetailCurrent, "tag") ||
                        (deviceOrigin && !isNodeTag(tagDetailCurrent))) && (
                        <Button
                          type="button"
                          variant="outline"
                          data-testid="tag-compatible-replacement"
                          onClick={() => {
                            closeDialog("tag");
                            setMaintenanceTag(tagDetailCurrent);
                          }}
                        >
                          {copy.policyMigrate}
                        </Button>
                      )}
                    </div>
                  )}
                  {isPolicyIdentityName(tagDetailCurrent, "tag") &&
                    !isNodeTag(tagDetailCurrent) && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {copy.policyManagementIncompatible}
                      </p>
                    )}
                </div>

                {tagDetailCurrent && (
                  <tagForm.Field name="accessors" mode="array">
                    {(accessorsField) => (
                      <fieldset
                        className="grid gap-2 rounded-md border p-3"
                        data-testid="tag-accessors-section"
                      >
                        <legend className="px-1 text-sm font-medium">
                          {copy.tagAccessorsSection}
                        </legend>
                        <p className="text-xs text-muted-foreground">
                          {copy.serviceSelectionHint}
                        </p>

                        {accessorsField.state.value.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic">
                            {copy.noAccessors}
                          </div>
                        ) : (
                          <div
                            className="grid gap-2 max-h-80 overflow-y-auto pe-1"
                            data-testid="tag-accessors-list"
                          >
                            {accessorsField.state.value.map((a, index) => (
                              <fieldset
                                key={a.who}
                                aria-label={whoDisplayLabel(a.who)}
                                className="grid min-w-0 gap-2 rounded-md border bg-background p-2"
                                data-testid={`tag-accessor-row-${a.who}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <Badge
                                      variant={
                                        isOrphanValue(a.who)
                                          ? "outline"
                                          : "secondary"
                                      }
                                      className={cn([
                                        "text-xs",
                                        isOrphanValue(a.who)
                                          ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                          : "",
                                      ])}
                                    >
                                      {isOrphanValue(a.who) ? (
                                        <>
                                          {copy.orphanReferenceBadge}
                                          <PolicyReferenceHelp
                                            identity={a.who}
                                          />
                                        </>
                                      ) : (
                                        whoDisplayKind(a.who)
                                      )}
                                    </Badge>
                                    <bdi
                                      dir="auto"
                                      className="font-medium break-all"
                                    >
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
                                    <Trash2
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                  </Button>
                                </div>
                                <tagForm.Field
                                  name={`accessors[${index}].services`}
                                >
                                  {(servicesField) => (
                                    <div className="flex flex-wrap gap-3 text-sm">
                                      {SERVICE_DEFS.map((def) => (
                                        <label
                                          key={def.id}
                                          htmlFor={`tag-accessor-svc-${a.who}-${def.id}`}
                                          className="flex items-start gap-1.5 cursor-pointer"
                                        >
                                          <Checkbox
                                            id={`tag-accessor-svc-${a.who}-${def.id}`}
                                            data-testid={`tag-accessor-svc-${a.who}-${def.id}`}
                                            aria-label={copy[def.labelKey]}
                                            aria-describedby={`tag-accessor-hint-${a.who}-${def.id}`}
                                            checked={servicesField.state.value.includes(
                                              def.id,
                                            )}
                                            disabled={a.readOnly}
                                            onBlur={servicesField.handleBlur}
                                            onCheckedChange={() =>
                                              toggleAccessorService(
                                                {
                                                  ...a,
                                                  services:
                                                    servicesField.state.value,
                                                },
                                                def.id,
                                              )
                                            }
                                          />
                                          <span className="grid max-w-xs gap-0.5">
                                            <span>{copy[def.labelKey]}</span>
                                            <span
                                              id={`tag-accessor-hint-${a.who}-${def.id}`}
                                              data-testid={`tag-accessor-hint-${a.who}-${def.id}`}
                                              className="text-xs text-muted-foreground"
                                            >
                                              {copy[def.hintKey]}
                                            </span>
                                          </span>
                                        </label>
                                      ))}
                                      <label
                                        htmlFor={`tag-accessor-svc-${a.who}-all`}
                                        className="flex items-center gap-1.5 cursor-pointer"
                                      >
                                        <Checkbox
                                          id={`tag-accessor-svc-${a.who}-all`}
                                          data-testid={`tag-accessor-svc-${a.who}-all`}
                                          checked={servicesField.state.value.includes(
                                            "all",
                                          )}
                                          disabled={a.readOnly}
                                          onBlur={servicesField.handleBlur}
                                          onCheckedChange={() =>
                                            toggleAccessorService(
                                              {
                                                ...a,
                                                services:
                                                  servicesField.state.value,
                                              },
                                              "all",
                                            )
                                          }
                                        />
                                        <span>{copy.svcAllLabel}</span>
                                      </label>
                                    </div>
                                  )}
                                </tagForm.Field>
                                <tagForm.AppField
                                  name={`accessors[${index}].customPorts`}
                                  listeners={{
                                    onChange: () => {
                                      ++closeGeneration.current;
                                      pendingPortDrafts.current.add(a.who);
                                    },
                                    onBlur: ({ value }) =>
                                      commitCustomPorts({
                                        ...a,
                                        customPorts: value,
                                      }),
                                  }}
                                >
                                  {(field) => (
                                    <field.TextField
                                      id={`tag-accessor-custom-${a.who}`}
                                      label={copy.svcCustomLabel}
                                      dir="ltr"
                                      className="h-8 text-xs"
                                      placeholder={copy.svcCustomPlaceholder}
                                      data-testid={`tag-accessor-custom-${a.who}`}
                                      disabled={a.readOnly}
                                      onKeyDown={(event) => {
                                        if (
                                          event.nativeEvent.isComposing ||
                                          event.nativeEvent.keyCode === 229
                                        )
                                          return;
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          commitCustomPorts({
                                            ...a,
                                            customPorts: field.state.value,
                                          });
                                        }
                                      }}
                                    />
                                  )}
                                </tagForm.AppField>
                                {renderRuleDetails(
                                  policyRules.filter((rule) =>
                                    a.ruleIds.includes(rule.id),
                                  ),
                                )}
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
                          searchPlaceholder={
                            copy.selectAccessorSearchPlaceholder
                          }
                          emptyText={copy.selectAccessorEmpty}
                        />
                      </fieldset>
                    )}
                  </tagForm.Field>
                )}

                {tagDetailCurrent && (
                  <tagForm.Field name="owners" mode="array">
                    {(field) => (
                      <fieldset
                        className="grid gap-2 rounded-md border p-3"
                        data-testid="tag-owners-section"
                      >
                        <legend className="px-1 text-sm font-medium">
                          {copy.tagOwnersSection}
                        </legend>

                        {field.state.value.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic">
                            {copy.policyEmptyOwners}
                          </div>
                        ) : (
                          <div
                            className="grid gap-1 max-h-64 overflow-y-auto pe-1"
                            data-testid="tag-owners-list"
                          >
                            {field.state.value.map((owner) => (
                              <div
                                key={owner}
                                className="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                                data-testid={`tag-owner-row-${owner}`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Badge
                                    variant={
                                      isOrphanValue(owner)
                                        ? "outline"
                                        : "secondary"
                                    }
                                    className={cn([
                                      "text-xs",
                                      isOrphanValue(owner)
                                        ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                        : "",
                                    ])}
                                  >
                                    {isOrphanValue(owner) ? (
                                      <>
                                        {copy.orphanReferenceBadge}
                                        <PolicyReferenceHelp identity={owner} />
                                      </>
                                    ) : (
                                      whoDisplayKind(owner)
                                    )}
                                  </Badge>
                                  <bdi
                                    dir="auto"
                                    className="font-medium break-all"
                                  >
                                    {whoDisplayLabel(owner)}
                                  </bdi>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`${copy.removeLabelManager} ${whoDisplayLabel(owner)}`}
                                  data-testid={`tag-owner-remove-${owner}`}
                                  onClick={() => {
                                    const owners = field.state.value.filter(
                                      (value) => value !== owner,
                                    );
                                    field.handleChange(owners);
                                    changeLabelManagers(owners);
                                  }}
                                >
                                  <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                          {copy.policyOwnerImpact}
                        </p>
                        {renderOwnerDependencies(tagDetailCurrent)}
                        <MemberPicker
                          options={ownerOptionsForCurrentTag}
                          disabled={
                            !isPolicyIdentityName(tagDetailCurrent, "tag") ||
                            (deviceOrigin && !isNodeTag(tagDetailCurrent))
                          }
                          testid="tag-add-owner"
                          onPick={(value) => {
                            const owner = value.trim();
                            if (field.state.value.includes(owner)) return;
                            const owners = [...field.state.value, owner];
                            field.handleChange(owners);
                            changeLabelManagers(owners);
                          }}
                          triggerLabel={copy.addLabelManager}
                          searchPlaceholder={
                            copy.selectLabelManagerSearchPlaceholder
                          }
                          emptyText={copy.selectLabelManagerEmpty}
                        />
                      </fieldset>
                    )}
                  </tagForm.Field>
                )}
              </div>

              {hasSaveFeedback && (
                <div className="shrink-0 border-t px-6 py-3">
                  {renderSaveFeedback("dialog-")}
                </div>
              )}
              {returnTo && (
                <div className="border-t px-6 py-3">
                  {renderReturnContext()}
                </div>
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
                <tagForm.SubmitButton
                  data-testid="tag-detail-close"
                  disabled={saving}
                >
                  {saving && (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {copy.policyDraftOnly}
                </tagForm.SubmitButton>
              </DialogFooter>
            </tagForm.Form>
          </tagForm.AppForm>
        </DialogContent>
        <AlertDialog
          open={tagRename !== null}
          onOpenChange={() => {
            ++closeGeneration.current;
            if (!renaming) setTagRename(null);
          }}
        >
          <AlertDialogContent data-testid="tag-rename-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.policyRenameReview}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.policyRenameScope}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p>
              <bdi dir="auto">
                {tagRename?.from} → {tagRename?.to}
              </bdi>
            </p>
            <label
              htmlFor="tag-rename-external"
              className="flex items-start gap-2 text-sm"
            >
              <Checkbox
                id="tag-rename-external"
                data-testid="tag-rename-external"
                checked={tagRename?.external ?? false}
                onCheckedChange={(external) =>
                  setTagRename(
                    (current) =>
                      current && { ...current, external: external === true },
                  )
                }
              />
              {copy.policyRenameExternal}
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="tag-rename-cancel"
                disabled={renaming}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                data-testid="tag-rename-confirm"
                disabled={!tagRename?.external || renaming}
                onClick={confirmTagRename}
              >
                {copy.policyRenameConfirm}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>

      <Dialog
        open={teamDetailOpen}
        onOpenChange={() => attemptDialogClose("team")}
      >
        <DialogContent
          className="sm:max-w-2xl flex flex-col gap-0 p-0 max-h-[85vh] overflow-hidden"
          data-testid="team-detail-dialog"
        >
          <teamForm.AppForm>
            <teamForm.Form className="flex min-h-0 flex-1 flex-col">
              <DialogHeader className="shrink-0 px-6 py-4 border-b">
                <DialogTitle className="break-all leading-snug">
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
                  <teamForm.AppField
                    name="name"
                    listeners={{
                      onChange: ({ fieldApi }) => {
                        ++closeGeneration.current;
                        fieldApi.setMeta((meta) => ({
                          ...meta,
                          errorMap: { ...meta.errorMap, onDynamic: undefined },
                        }));
                      },
                      onBlur: () => {
                        void submitForm(teamForm, "name");
                      },
                    }}
                  >
                    {(field) => (
                      <div className="flex items-end gap-2">
                        <field.TextField
                          id="team-name-input"
                          data-testid="team-name-input"
                          label={copy.teamName}
                          fieldClassName="flex-1"
                          placeholder={copy.teamNameHint}
                          onKeyDown={(event) => nameKeyDown(event, "team")}
                        />
                        {!teamDetailCurrent && (
                          <teamForm.SubmitButton
                            type="button"
                            variant="outline"
                            disabled={!field.state.value.trim()}
                            data-testid="team-name-confirm"
                            onClick={() => {
                              void submitForm(teamForm, "name");
                            }}
                          >
                            {copy.confirm}
                          </teamForm.SubmitButton>
                        )}
                      </div>
                    )}
                  </teamForm.AppField>
                </div>

                {teamDetailCurrent && (
                  <teamForm.Field name="members" mode="array">
                    {(field) => (
                      <fieldset
                        className="grid gap-2 rounded-md border p-3"
                        data-testid="team-members-section"
                      >
                        <legend className="px-1 text-sm font-medium">
                          {copy.teamMembersSection}
                        </legend>

                        {field.state.value.length === 0 ? (
                          <div className="text-xs text-muted-foreground italic">
                            {copy.noPolicyGroupMembers}
                          </div>
                        ) : (
                          <div
                            className="grid gap-1 max-h-64 overflow-y-auto pe-1"
                            data-testid="team-members-list"
                          >
                            {field.state.value.map((member) => (
                              <div
                                key={member}
                                className="flex items-center justify-between gap-2 rounded-md border bg-background p-2"
                                data-testid={`team-member-row-${member}`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Badge
                                    variant={
                                      isOrphanValue(member)
                                        ? "outline"
                                        : "secondary"
                                    }
                                    className={cn([
                                      "text-xs",
                                      isOrphanValue(member)
                                        ? "cursor-help border-amber-300/60 bg-amber-50/60 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                                        : "",
                                    ])}
                                  >
                                    {isOrphanValue(member) ? (
                                      <>
                                        {copy.orphanReferenceBadge}
                                        <PolicyReferenceHelp
                                          identity={member}
                                        />
                                      </>
                                    ) : (
                                      whoDisplayKind(member)
                                    )}
                                  </Badge>
                                  <bdi
                                    dir="auto"
                                    className="font-medium break-all"
                                  >
                                    {whoDisplayLabel(member)}
                                  </bdi>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`${copy.removeTeamMember} ${whoDisplayLabel(member)}`}
                                  data-testid={`team-member-remove-${member}`}
                                  onClick={() => {
                                    const members = field.state.value.filter(
                                      (value) => value !== member,
                                    );
                                    field.handleChange(members);
                                    changeTeamMembers(members);
                                  }}
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
                          onPick={(value) => {
                            const member = value.trim();
                            if (field.state.value.includes(member)) return;
                            const members = [...field.state.value, member];
                            field.handleChange(members);
                            changeTeamMembers(members);
                          }}
                          triggerLabel={copy.addMemberToTeam}
                          searchPlaceholder={copy.selectMemberSearchPlaceholder}
                          emptyText={copy.selectMemberEmpty}
                        />
                      </fieldset>
                    )}
                  </teamForm.Field>
                )}

                {teamDetailCurrent && (
                  <section
                    className="grid gap-2 rounded-md border p-3 text-sm"
                    data-testid="team-owner-dependencies"
                  >
                    <h3 className="font-medium">
                      {copy.policyOwnerDependencies}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {copy.policyDependencyDisclaimer}
                    </p>
                    <ul className="grid gap-1">
                      {policyTagOwners.flatMap((owner) =>
                        tagOwnerDependencies(policyDesignerState, owner.tag)
                          .filter((dependency) =>
                            dependency.path.includes(teamDetailCurrent),
                          )
                          .map((dependency) => (
                            <li key={JSON.stringify(dependency.path)}>
                              <bdi dir="auto">
                                {dependency.path.join(" → ")}
                              </bdi>
                            </li>
                          )),
                      )}
                    </ul>
                  </section>
                )}

                {teamDetailCurrent && (
                  <fieldset
                    className="grid gap-2 rounded-md border p-3"
                    data-testid="team-access-view"
                  >
                    <legend className="px-1 text-sm font-medium">
                      {copy.teamAccessView}
                    </legend>
                    <p className="text-xs text-muted-foreground">
                      {copy.teamAccessViewHint}
                    </p>
                    {teamAccessRows.length === 0 ? (
                      <div className="text-xs text-muted-foreground italic">
                        {copy.noTeamAccess}
                      </div>
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
                            <span className="break-all">
                              {stripTagPrefix(row.tagName)}
                            </span>
                            <div className="min-w-0 text-xs text-muted-foreground">
                              {serviceSummary(row.services, row.customPorts)}
                              {renderRuleDetails(
                                policyRules.filter(
                                  (rule) =>
                                    parseCommaList(rule.source).includes(
                                      teamDetailCurrent,
                                    ) &&
                                    parseCommaList(rule.destination).includes(
                                      row.tagName,
                                    ),
                                ),
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </fieldset>
                )}
              </div>

              {hasSaveFeedback && (
                <div className="shrink-0 border-t px-6 py-3">
                  {renderSaveFeedback("dialog-")}
                </div>
              )}
              {returnTo && (
                <div className="border-t px-6 py-3">
                  {renderReturnContext()}
                </div>
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
                <teamForm.SubmitButton
                  data-testid="team-detail-close"
                  disabled={saving}
                >
                  {saving && (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {copy.policyDraftOnly}
                </teamForm.SubmitButton>
              </DialogFooter>
            </teamForm.Form>
          </teamForm.AppForm>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={highRiskConfirmOpen}
        onOpenChange={(open) => setPolicyState({ highRiskConfirmOpen: open })}
      >
        <AlertDialogContent data-testid="high-risk-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.highRiskConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.highRiskConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {highRiskScope && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt>{copy.ipRuleSourcePlaceholder}</dt>
              <dd>
                <bdi dir="auto">{whoDisplayLabel(highRiskScope.who)}</bdi>
              </dd>
              <dt>{copy.ipRuleDestinationPlaceholder}</dt>
              <dd>
                <bdi dir="auto">{highRiskScope.target}</bdi>
              </dd>
              <dt>{copy.ipRulePortsPlaceholder}</dt>
              <dd>
                {highRiskScope.ports === "*" ? (
                  copy.policyAllPorts
                ) : (
                  <bdi dir="ltr">{highRiskScope.ports}</bdi>
                )}
              </dd>
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="high-risk-cancel"
              onClick={() => cancelHighRisk()}
            >
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

      <AlertDialog
        open={policyRemovalDialogOpen}
        onOpenChange={closePolicyRemovalDialog}
      >
        <AlertDialogContent data-testid="remove-policy-item-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removalTag
                ? copy.policyPolicyOnlyRemove
                : copy.confirmRemovePolicyItemTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removalTag
                ? copy.policyPolicyOnlyScope
                : copy.confirmRemovePolicyItemDescription}
              {pendingPolicyRemoval && (
                <span className="mt-2 block break-all font-medium text-foreground">
                  <bdi
                    dir={pendingPolicyRemoval.kind === "rule" ? "ltr" : "auto"}
                  >
                    {pendingPolicyRemoval.label}
                  </bdi>
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removalPreview && !removalPreview.ok && (
            <p
              data-testid="policy-removal-error"
              className="text-sm text-destructive"
            >
              {identityErrorText(removalPreview.issue, removalKind)}
            </p>
          )}
          {pendingPolicyRemoval?.kind === "rule" && (
            <>
              <RuleRestrictions
                extras={
                  policyRules.find(
                    (rule) => rule.id === pendingPolicyRemoval.id,
                  )?.extras
                }
                expanded
              />
              <p
                data-testid="policy-removal-consequence"
                className="text-sm text-muted-foreground"
              >
                {copy.removeIpRuleConsequence}
              </p>
            </>
          )}
          {removalTag && (
            <div
              className="grid gap-2 text-sm"
              data-testid="policy-removal-inventory"
            >
              {!removalReady && (
                <Notice tone="warning" title={copy.policyInventoryUnknownTitle}>
                  <details>
                    <summary className="cursor-pointer">{copy.details}</summary>
                    <p className="mt-1">{copy.policyInventoryUnknown}</p>
                  </details>
                </Notice>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={refreshSnapshotInFlight > 0}
                data-testid="policy-removal-refresh"
                onClick={() => void readTagRemoval(removalTag, true)}
              >
                {copy.policyInventoryRefresh}
              </Button>
              <h3 className="font-medium">{copy.policyObservedNodes}</h3>
              <ul>
                {snapshot.nodes
                  .filter((node) => node.tags.includes(removalTag))
                  .map((node) => (
                    <li key={node.id}>
                      <bdi dir="auto">
                        {node.name} · {node.id} · {node.tags.join(", ")}
                      </bdi>
                    </li>
                  ))}
              </ul>
              <h3 className="font-medium">{copy.policyObservedKeys}</h3>
              <ul>
                {removalObservation?.keys.map((key) => (
                  <li key={key.id}>
                    <bdi dir="auto">{key.id}</bdi> ·{" "}
                    {key.registration === "available"
                      ? copy.inviteRegistrationReady
                      : key.registration === "expired"
                        ? copy.inviteRegistrationExpired
                        : key.registration === "exhausted"
                          ? copy.inviteRegistrationUsed
                          : copy.unknown}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {copy.policyKeyDeployment}
              </p>
              <h3 className="font-medium">{copy.policyObservedReferences}</h3>
              <pre
                dir="ltr"
                className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-xs"
              >
                {removalObservation?.referencePaths.join("\n")}
              </pre>
              {removalNext && (
                <details>
                  <summary className="cursor-pointer">
                    {copy.policyRawDiff}
                  </summary>
                  <h4>{copy.policyRawOriginal}</h4>
                  <pre
                    dir="ltr"
                    className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs"
                  >
                    {draftText}
                  </pre>
                  <h4>{copy.policyFullSubmitted}</h4>
                  <pre
                    dir="ltr"
                    className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs"
                  >
                    {JSON.stringify(serializePolicy(removalNext), null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
          {removalDevices > 0 && (
            <p
              data-testid="policy-removal-devices"
              className="text-sm text-muted-foreground"
            >
              {pluralize(removalDevices, "labelRemovalDevices")}
            </p>
          )}
          {removalImpact && (
            <p
              data-testid="policy-removal-impact"
              className="text-sm text-muted-foreground"
            >
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
              disabled={!removalNext || !removalReady}
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40"
              onClick={confirmRemovePolicyItem}
            >
              {copy.removeItem}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={unsavedConfirmOpen}
        onOpenChange={(open) => {
          setUnsavedConfirmOpen(open);
          if (!open && ipNavigation.status === "blocked") ipNavigation.reset();
        }}
      >
        <AlertDialogContent data-testid="unsaved-changes-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.unsavedChangesTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.dialogUnsavedChangesBody}
            </AlertDialogDescription>
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
              variant="outline"
              data-testid="unsaved-changes-keep-draft"
              disabled={saving || !pendingDialogClose}
              onClick={
                pendingDialogClose
                  ? () => void keepDraftAndClose(pendingDialogClose)
                  : undefined
              }
            >
              {copy.policyDraftOnly}
            </Button>
            {ipNavigation.status !== "blocked" && (
              <Button
                type="button"
                data-testid="unsaved-changes-save"
                disabled={saving}
                onClick={() => saveAndClose()}
              >
                {saving && (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {copy.policyPublishAll}
              </Button>
            )}
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
            <AlertDialogDescription>
              {copy.cleanupOrphanRefsConfirmBody}
            </AlertDialogDescription>
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
      <AlertDialog
        open={pendingTemplate !== null}
        onOpenChange={() => setPendingTemplate(null)}
      >
        <AlertDialogContent data-testid="template-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.templateReplaceTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.templateReplaceBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul
            className="grid gap-1 text-sm"
            data-testid="template-confirm-removed"
          >
            {replacedRules.map((rule) => (
              <li
                key={rule.id}
                className="break-all rounded-md border px-3 py-2 font-mono text-xs"
              >
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

      <AlertDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
      >
        <AlertDialogContent data-testid="discard-policy-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {copy.discardPolicyChangesTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {copy.discardPolicyChangesBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="discard-policy-cancel">
              {copy.cancel}
            </AlertDialogCancel>
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
