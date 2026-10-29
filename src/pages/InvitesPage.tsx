import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Clock,
  EllipsisVertical,
  Filter,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HeadscaleUser, PreAuthKey } from "@/api/contracts";
import { CopyButton } from "@/components/app/copy-button";
import { useAppForm } from "@/components/app/form";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/app/native-select";
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
import {
  useDeviceSetup,
  useRevealCreatedInvite,
} from "@/composables/useDeviceSetup";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useHeadscaleClient } from "@/composables/useHeadscaleClient";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { isTimestampExpired as isExpired } from "@/domain/node-status";
import { observeTags, registrationKeyStatus } from "@/domain/tag-lifecycle";
import { useHeadscaleI18n } from "@/i18n";
import {
  keyEphemeralClass,
  keyKindClass,
  keyStatusClass,
  keyTagClass,
} from "@/utils/status-class";
import { isHttpUrl, tailscaleUpCommand } from "@/utils/strings";

const INVITE_FILTERS = ["all", "ready", "used", "expired", "tagged"] as const;
type InviteActionTarget = { kind: "expire" | "delete"; key: PreAuthKey };
/** Whether a listed key (`hskey-auth-<prefix>-***`, or a legacy key in full) is this one-time secret. */
function isListedSecret(listed: string, secret: string) {
  return listed.endsWith("***")
    ? secret.startsWith(listed.slice(0, -3))
    : listed === secret;
}
export default function InvitesPage() {
  const session = useSession();
  const { stale } = useStore(session.drafts);
  const { copy } = useProductCopy();
  const { t } = useHeadscaleI18n();
  const {
    snapshot,
    isReady,
    refreshErrors,
    refreshSnapshotInFlight,
    segmentStatus,
  } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshInvites } =
    useSegment("identity");
  const { settings } = useHeadscaleClient();
  const { isActionPending, actionError, actionOutcome, clearActionFeedback } =
    useActionFeedback();
  const {
    lastCreatedInvite,
    loginServer,
    setState: setDeviceSetupState,
  } = useDeviceSetup();
  const createdInviteRef = useRef<HTMLDivElement>(null);
  // One frame after mount: the router resets the scroll position after the navigation that opened this page.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useRevealCreatedInvite(createdInviteRef, settled);
  const navigate = useNavigate();
  const searchParams = useSearch({ strict: false }) as Record<string, unknown>;
  const inviteFilter =
    INVITE_FILTERS.find((filter) => filter === searchParams.filter) ?? "all";
  const exactTag = typeof searchParams.tag === "string" ? searchParams.tag : "";
  const [inviteSearch, setInviteSearch] = useState("");
  function changeInviteFilter(value: string) {
    ++inviteContext.current;
    void navigate({
      to: ".",
      search: (current: Record<string, unknown>) => ({
        ...current,
        filter: value === "all" ? undefined : value,
      }),
      replace: true,
    });
  }
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [restoredInvite, setRestoredInvite] =
    useState<AuthKeyDialogDraft | null>(null);
  const inviteContext = useRef(0);
  // History and URL changes must invalidate pending restoration even without a filter-control event.
  useEffect(() => {
    ++inviteContext.current;
  }, [inviteFilter, exactTag]);
  const hasInviteDefaults = useRef(false);
  useEffect(
    () => () => {
      ++inviteContext.current;
    },
    [],
  );
  const [pendingInviteAction, setPendingInviteAction] =
    useState<InviteActionTarget | null>(null);
  const inviteActionContext = useRef(0);
  useEffect(
    () => () => {
      ++inviteActionContext.current;
    },
    [],
  );
  const [inviteForm, setInviteForm] = useState<AuthKeyDialogDefaults>({
    user: "1",
    reusable: false,
    ephemeral: false,
    aclTags: "",
  });
  useSessionDraft(inviteDialogOpen || pendingInviteAction !== null);
  const inviteDialogGuard = useRefreshGuard("identity");
  const inviteReturn = useInviteTagReturn(
    "invite",
    (record) => {
      const form = record.form;
      hasInviteDefaults.current = true;
      ++inviteContext.current;
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
      const filters = new URLSearchParams(record.filter);
      setInviteSearch(filters.get("q") ?? "");
      const filter = filters.get("filter");
      void navigate({
        to: "/invites",
        search: {
          filter: INVITE_FILTERS.find(
            (value) => value === filter && value !== "all",
          ),
          tag: filters.get("tag") || undefined,
        },
        replace: true,
      });
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
  const { formatDate, userLabel, keyStatus, shortSecret, hasVisibleUser } =
    useDisplayHelpers();
  const ownerText = (user: PreAuthKey["user"]) =>
    user ? userLabel(user) : copy.inviteNoOwner;
  const visibleUsers = snapshot.users.filter(hasVisibleUser);
  const query = inviteSearch.trim().toLowerCase();
  const filteredPreAuthKeys = snapshot.preAuthKeys.filter((key) => {
    const searchable = [
      key.key,
      ownerText(key.user),
      key.user?.name,
      key.user?.email,
      keyStatus(key),
      key.reusable ? copy.reusable : copy.oneTimeKey,
      key.ephemeral ? copy.ephemeral : "",
      key.expiration,
      key.createdAt,
      key.aclTags.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const matchesSearch = !query || searchable.includes(query);
    const matchesFilter =
      inviteFilter === "all" ||
      (inviteFilter === "ready" &&
        !key.used &&
        registrationKeyStatus(key).registration === "available") ||
      (inviteFilter === "used" && key.used) ||
      (inviteFilter === "expired" && isExpired(key.expiration)) ||
      (inviteFilter === "tagged" && key.aclTags.length > 0);
    return (
      matchesSearch &&
      matchesFilter &&
      (!exactTag || key.aclTags.includes(exactTag))
    );
  });
  const createdKey = snapshot.preAuthKeys.find((key) =>
    isListedSecret(key.key, lastCreatedInvite),
  );
  const createdKeyStatus =
    !isReady || refreshSnapshotInFlight > 0 || refreshErrors.identity
      ? copy.createdKeyUnverified
      : !createdKey ||
          isExpired(createdKey.expiration) ||
          (createdKey.used && !createdKey.reusable)
        ? copy.createdKeyUnavailable
        : "";
  const authKeyDialogUsers = visibleUsers.map((user) =>
    authKeyDialogUser(user, copy.unknown),
  );
  const loginServerUrl = loginServer ?? settings.baseUrl;
  const loginServerForm = useAppForm({
    defaultValues: { loginServer: loginServerUrl },
    onSubmit: ({ value, formApi }) => {
      if (!session.drafts.isCurrent()) return;
      formApi.setFieldValue("loginServer", value.loginServer.trim());
    },
  });
  useEffect(() => {
    if (stale || loginServerForm.state.values.loginServer === loginServerUrl)
      return;
    // 外部草稿只更新该字段，不反向回写或覆盖其他页面刚生成的一次性密钥。
    loginServerForm.setFieldValue("loginServer", loginServerUrl, {
      dontRunListeners: true,
      dontUpdateMeta: true,
    });
  }, [loginServerUrl, loginServerForm, stale]);
  const validateLoginServer = ({ value }: { value: string }) =>
    isHttpUrl(value) ? undefined : t("connectionInvalidUrl");
  const loginServerValid = isHttpUrl(loginServerUrl);
  const installCommand =
    lastCreatedInvite && loginServerValid
      ? tailscaleUpCommand(loginServerUrl, lastCreatedInvite)
      : "";
  const { mutate } = useMutation();
  const createPreAuthKey = useCreatePreAuthKey();
  function openInviteDialog() {
    clearActionFeedback("create-invite");
    ++inviteContext.current;
    setRestoredInvite(null);
    if (!hasInviteDefaults.current) {
      setInviteForm((current) => ({
        ...current,
        user: visibleUsers[0]?.id ?? "",
      }));
    }
    const token = inviteDialogGuard.next();
    setInviteDialogOpen(true);
    void inviteDialogGuard.refresh(token, () => {});
  }
  // The create dialog has no trigger (openInviteDialog opens it), so Base UI only ever reports it closing.
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
    hasInviteDefaults.current = true;
    setInviteForm(toAuthKeyDefaults(payload));
    const created = await createPreAuthKey(payload);
    if (
      created &&
      context === inviteContext.current &&
      ownsSession() &&
      viewEpoch === session.drafts.getSnapshot().viewEpoch
    )
      closeInviteDialog();
  }
  function manageInviteTags(form: AuthKeyDialogDraft, tag?: string) {
    const filters = new URLSearchParams({
      filter: inviteFilter,
      tag: exactTag,
      q: inviteSearch,
    });
    ++inviteContext.current;
    if (!inviteReturn.manageTags(form, tag, filters.toString())) return;
    setInviteDialogOpen(false);
    inviteDialogGuard.cancel();
  }
  function requestInviteAction(
    kind: InviteActionTarget["kind"],
    key: PreAuthKey,
  ) {
    ++inviteActionContext.current;
    clearActionFeedback("invite-action");
    setPendingInviteAction({ kind, key });
  }
  function closeInviteActionDialog() {
    if (isActionPending("invite-action")) return;
    ++inviteActionContext.current;
    setPendingInviteAction(null);
    clearActionFeedback("invite-action");
  }
  async function confirmInviteAction(target: InviteActionTarget) {
    if (isActionPending("invite-action")) return;
    const context = inviteActionContext.current;
    const scope = session.tagLifecycle.captureScope();
    const completed = await mutate(
      "invite-action",
      target.kind === "expire"
        ? { endpoint: "expirePreAuthKey", input: { id: target.key.id } }
        : { endpoint: "deletePreAuthKey", input: { id: target.key.id } },
    );
    if (
      !completed ||
      context !== inviteActionContext.current ||
      !session.tagLifecycle.isCurrent(scope)
    )
      return;
    // Clear only this key's current one-time secret, not a newer result from another host.
    if (
      isListedSecret(
        target.key.key,
        session.deviceSetup.getSnapshot().lastCreatedInvite,
      )
    )
      setDeviceSetupState({ lastCreatedInvite: "" });
    closeInviteActionDialog();
  }
  const stopNotice = ["unknown", "possibly-applied"].includes(
    actionOutcome("invite-action")?.status ?? "",
  ) ? (
    <section
      className="grid gap-2 rounded-md border p-3 text-sm"
      data-testid="invite-stop-notice"
    >
      <p>{copy.inviteStopUnresolved}</p>
      <Link
        to="/invites"
        data-testid="invite-stop-verify"
        onClick={closeInviteActionDialog}
        className="w-fit underline underline-offset-4"
      >
        {copy.invitesTitle}
      </Link>
    </section>
  ) : null;

  function openUserDetails(user: HeadscaleUser) {
    void navigate({
      to: "/members",
      search: { user: user.id, from: "invites", popup: "user" },
    });
  }
  return (
    <section className="space-y-3 lg:space-y-4">
      <div className="grid gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy.invitesTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {copy.invitesSubtitle}
          </p>
        </div>
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
      {!inviteDialogOpen && (
        <CreateKeyOutcomeNotice outcome={actionOutcome("create-invite")} />
      )}
      {!pendingInviteAction && stopNotice}
      <div className="space-y-2" data-testid="invite-table-shell">
        {exactTag && (
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="invite-exact-tag"
          >
            <span className="text-sm">{copy.inviteExactTag}</span>
            <Badge variant="outline">
              <bdi dir="ltr">{exactTag}</bdi>
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="invite-clear-tag"
              onClick={() => {
                ++inviteContext.current;
                void navigate({
                  to: ".",
                  search: (current: Record<string, unknown>) => ({
                    ...current,
                    tag: undefined,
                  }),
                  replace: true,
                });
              }}
            >
              {copy.inviteClearTag}
            </Button>
          </div>
        )}
        <div
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          data-testid="invite-toolbar"
        >
          <div className="w-full sm:max-w-sm">
            <Label htmlFor="invite-search" className="sr-only">
              {copy.searchAuthKeys}
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="invite-search"
                value={inviteSearch}
                onChange={(event) => {
                  ++inviteContext.current;
                  setInviteSearch(event.target.value);
                }}
                data-testid="invite-search"
                className="ps-8"
                placeholder={copy.searchAuthKeys}
              />
            </div>
          </div>
          <div className="w-full sm:w-40">
            <Label htmlFor="invite-filter" className="sr-only">
              {copy.filters}
            </Label>
            <div className="relative">
              <Filter
                className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <NativeSelect
                id="invite-filter"
                value={inviteFilter}
                onChange={(event) => changeInviteFilter(event.target.value)}
                data-testid="invite-filter"
                className="[&_select]:ps-8"
              >
                <NativeSelectOption value="all">
                  {copy.allAuthKeys}
                </NativeSelectOption>
                <NativeSelectOption value="ready">
                  {copy.readyKeys}
                </NativeSelectOption>
                <NativeSelectOption value="used">
                  {copy.used}
                </NativeSelectOption>
                <NativeSelectOption value="expired">
                  {copy.expiredOnly}
                </NativeSelectOption>
                <NativeSelectOption value="tagged">
                  {copy.taggedKeys}
                </NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <p
            data-testid="invite-count"
            className="whitespace-nowrap text-xs text-muted-foreground sm:ms-auto"
          >
            {filteredPreAuthKeys.length} / {snapshot.preAuthKeys.length}
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="refresh-auth-keys"
            aria-label={copy.refreshData}
            title={copy.refreshData}
            disabled={isRefreshingSnapshot}
            onClick={refreshInvites}
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
          <Button data-testid="open-create-invite" onClick={openInviteDialog}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {copy.createInvite}
          </Button>
        </div>
        <Card className="min-w-0 overflow-hidden" data-testid="invite-table">
          <Table aria-label={copy.invitesTitle}>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.status}</TableHead>
                <TableHead>{copy.inviteCreatorLabel}</TableHead>
                <TableHead>{copy.inviteKey}</TableHead>
                <TableHead>{copy.expires}</TableHead>
                <TableHead>{copy.aclTags}</TableHead>
                <TableHead>{copy.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPreAuthKeys.map((key) => {
                const owner = hasVisibleUser(key.user) ? key.user : null;
                return (
                  <TableRow key={key.id} data-testid={`invite-${key.id}`}>
                    <TableCell className="w-28">
                      <Badge
                        variant="outline"
                        className={keyStatusClass(key)}
                        data-testid={`invite-status-${key.id}`}
                      >
                        {keyStatus(key)}
                      </Badge>
                      <p
                        className="mt-1 max-w-56 text-xs text-muted-foreground"
                        data-testid={`invite-registration-${key.id}`}
                      >
                        {registrationKeyStatus(key).registration === "available"
                          ? copy.inviteRegistrationReady
                          : registrationKeyStatus(key).registration ===
                              "expired"
                            ? copy.inviteRegistrationExpired
                            : registrationKeyStatus(key).registration ===
                                "exhausted"
                              ? copy.inviteRegistrationUsed
                              : copy.unknown}
                      </p>
                    </TableCell>
                    <TableCell className="min-w-36 font-medium">
                      {owner ? (
                        <button
                          type="button"
                          className="text-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          data-testid={`invite-owner-link-${key.id}`}
                          onClick={() => openUserDetails(owner)}
                        >
                          <bdi dir="auto">{ownerText(key.user)}</bdi>
                        </button>
                      ) : (
                        <bdi dir="auto">{ownerText(key.user)}</bdi>
                      )}
                    </TableCell>
                    <TableCell className="min-w-64">
                      <code
                        dir="ltr"
                        className="break-all rounded bg-secondary px-1.5 py-0.5 text-xs"
                      >
                        {key.key}
                      </code>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge
                          variant="outline"
                          className={keyKindClass(key)}
                          data-testid={`invite-kind-${key.id}`}
                        >
                          {key.reusable ? copy.reusable : copy.oneTimeKey}
                        </Badge>
                        {key.ephemeral && (
                          <Badge
                            variant="outline"
                            className={keyEphemeralClass()}
                            data-testid={`invite-ephemeral-${key.id}`}
                          >
                            {copy.ephemeral}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-40 text-sm text-muted-foreground">
                      {formatDate(key.expiration)}
                    </TableCell>
                    <TableCell
                      className="min-w-36"
                      data-testid={`invite-tags-${key.id}`}
                    >
                      {key.aclTags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {key.aclTags.map((tag, tagIndex) => (
                            <Badge
                              key={tag}
                              variant="outline"
                              className={keyTagClass(tag)}
                              data-testid={`invite-tag-${key.id}-${tagIndex}`}
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-16">
                      <div className="flex justify-start">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="outline"
                                size="icon"
                                data-testid={`invite-actions-trigger-${key.id}`}
                                aria-label={`${copy.actions}: ${shortSecret(key.key)}`}
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
                            className="w-56"
                            data-testid={`invite-actions-menu-${key.id}`}
                          >
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>
                                {copy.actions}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {/* A used one-time key or an expired key can no longer be expired. */}
                              {!isExpired(key.expiration) &&
                                !(key.used && !key.reusable) && (
                                  <DropdownMenuItem
                                    data-testid={`expire-invite-${key.id}`}
                                    onClick={() =>
                                      requestInviteAction("expire", key)
                                    }
                                  >
                                    <Clock
                                      className="h-4 w-4"
                                      aria-hidden="true"
                                    />
                                    {copy.expireInvite}
                                  </DropdownMenuItem>
                                )}
                              <DropdownMenuItem
                                variant="destructive"
                                data-testid={`delete-invite-${key.id}`}
                                onClick={() =>
                                  requestInviteAction("delete", key)
                                }
                              >
                                <Trash2
                                  className="h-4 w-4"
                                  aria-hidden="true"
                                />
                                {copy.deleteInvite}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredPreAuthKeys.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-6 text-sm text-muted-foreground"
                  >
                    {snapshot.preAuthKeys.length > 0 ? (
                      copy.noAuthKeys
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        {copy.noAuthKeysYet}
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="empty-create-invite"
                          onClick={openInviteDialog}
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {copy.createInvite}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

        <p
          className="text-xs text-muted-foreground"
          data-testid="invite-old-deployment-hint"
        >
          {copy.inviteOldDeploymentHint}
        </p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="invite-rotation-hint"
        >
          {copy.inviteRotationHint}
        </p>
        {lastCreatedInvite && (
          <Card
            ref={createdInviteRef}
            tabIndex={-1}
            role="group"
            aria-label={copy.authKeyCreated}
            className="gap-0 p-3"
            data-testid="created-invite"
          >
            <p className="text-sm text-muted-foreground">{copy.inviteKey}</p>
            <p data-testid="invite-created-not-joined" className="mt-2 text-sm">
              {copy.inviteKeyCreatedNotJoined}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {copy.keyOneTimeNotice}
            </p>
            {actionOutcome("create-invite")?.status === "confirmed" &&
              (segmentStatus.identity === "error" ||
                Boolean(refreshErrors.identity)) && (
                <p
                  data-testid="invite-created-refresh-failed"
                  className="mt-2 text-sm"
                >
                  {copy.inviteCreateConfirmedRefreshFailed}
                </p>
              )}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="invite-view-devices"
                onClick={() => void navigate({ to: "/devices" })}
              >
                {copy.viewMachines}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="invite-refresh-devices"
                disabled={isRefreshingSnapshot}
                onClick={() =>
                  void session.snapshot.refreshSegments(["fabric", "identity"])
                }
              >
                {copy.refreshData}
              </Button>
            </div>
            {createdKeyStatus && (
              <p
                data-testid="created-invite-status"
                className="mt-2 text-sm font-medium"
              >
                {createdKeyStatus}
              </p>
            )}
            <div className="mt-2 grid gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-secondary px-2 py-1 text-xs">
                {lastCreatedInvite}
              </code>
              <CopyButton
                size="sm"
                variant="outline"
                className="w-full"
                data-testid="copy-created-invite"
                value={lastCreatedInvite}
              >
                {copy.copy}
              </CopyButton>
            </div>
            <loginServerForm.AppForm>
              <loginServerForm.Form className="mt-4 grid gap-2">
                <loginServerForm.AppField
                  name="loginServer"
                  validators={{
                    onChange: validateLoginServer,
                    onDynamic: validateLoginServer,
                  }}
                  listeners={{
                    onChange: ({ value }) => {
                      if (session.drafts.isCurrent())
                        setDeviceSetupState({ loginServer: value });
                    },
                  }}
                >
                  {(field) => (
                    <field.TextField
                      id="invite-login-server"
                      label={copy.loginServerUrl}
                      description={copy.loginServerUrlHint}
                      data-testid="invite-login-server"
                      dir="ltr"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={stale !== null}
                    />
                  )}
                </loginServerForm.AppField>
              </loginServerForm.Form>
            </loginServerForm.AppForm>
            {installCommand ? (
              <>
                <p className="mt-4 text-sm text-muted-foreground">
                  {copy.installCommand}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {copy.connectionCommandHint}{" "}
                  <a
                    data-testid="invite-install-docs"
                    href="https://tailscale.com/kb/1017/install"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    {copy.learnMore}
                  </a>
                </p>
                <div className="mt-2 grid gap-2">
                  <code className="break-all rounded-md bg-secondary px-2 py-1 text-xs">
                    {installCommand}
                  </code>
                  <CopyButton
                    size="sm"
                    variant="outline"
                    className="w-full"
                    data-testid="copy-created-install-command"
                    value={installCommand}
                  >
                    {copy.copyCommand}
                  </CopyButton>
                </div>
              </>
            ) : null}
          </Card>
        )}
      </div>

      <CreateAuthKeyDialog
        paused={stale !== null}
        open={inviteDialogOpen}
        users={authKeyDialogUsers}
        defaults={inviteForm}
        labels={authKeyDialogLabels(copy)}
        finalFocus={createdInviteRef}
        isSubmitting={isCreatingInvite}
        error={actionError("create-invite")}
        restoredDraft={restoredInvite}
        tagOptions={declaredTags ?? []}
        declaredTags={declaredTags}
        tagReadError={refreshErrors.policy}
        onRetryTags={() => void session.snapshot.refreshSegments(["policy"])}
        onManageTags={manageInviteTags}
        outcome={
          <CreateKeyOutcomeNotice
            outcome={actionOutcome("create-invite")}
            onVerify={closeInviteDialog}
          />
        }
        onOpenChange={closeInviteDialog}
        onSubmit={createInvite}
      />

      <AlertDialog
        open={Boolean(pendingInviteAction)}
        onOpenChange={closeInviteActionDialog}
      >
        {pendingInviteAction && (
          <AlertDialogContent
            data-testid={
              pendingInviteAction.kind === "expire"
                ? "expire-invite-dialog"
                : "delete-invite-dialog"
            }
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingInviteAction.kind === "expire"
                  ? copy.expireInviteTitle
                  : copy.deleteInviteTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pendingInviteAction.kind === "expire"
                  ? copy.expireInviteDescription
                  : copy.deleteInviteDescription}
                <span className="mt-2 block" data-testid="invite-action-effect">
                  {pendingInviteAction.kind === "expire"
                    ? copy.inviteExpiryEffectHint
                    : copy.inviteDeleteEffectHint}
                </span>
                <code
                  dir="ltr"
                  className="mt-2 block break-all font-mono text-xs text-foreground"
                  data-testid="invite-action-key"
                >
                  {pendingInviteAction.key.key}
                </code>
                <span
                  className="mt-1 block text-foreground"
                  data-testid="invite-action-owner"
                >
                  {copy.inviteOwner}:{" "}
                  <bdi dir="auto">
                    {ownerText(pendingInviteAction.key.user)}
                  </bdi>
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="cancel-invite-action"
                disabled={isActionPending("invite-action")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                data-testid="confirm-invite-action"
                disabled={isActionPending("invite-action")}
                onClick={() => confirmInviteAction(pendingInviteAction)}
              >
                {isActionPending("invite-action") && (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {pendingInviteAction.kind === "expire"
                  ? copy.confirmExpireInvite
                  : copy.confirmDeleteInvite}
              </Button>
            </AlertDialogFooter>
            {stopNotice}
            {actionError("invite-action") && (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="invite-action-error"
              >
                {actionError("invite-action")}
              </p>
            )}
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  );
}
