import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, RefreshCw, Router, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
import { Notice } from "@/components/app/notice";
import { Tooltip } from "@/components/app/tooltip";
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
import { useSession } from "@/composables/session-context";
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useRouteIntent } from "@/composables/useRouteIntent";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { cn } from "@/lib/utils";
import { nodePendingRoutes, nodeRevocationTargets } from "@/utils/node";
import {
  isExitRoute,
  nodeStatusClass,
  pendingRouteClass,
} from "@/utils/status-class";

type RouteApprovalTarget = { node: HeadscaleNode; route: string };
// Headscale approves either exit prefix together with the other, so the UI treats them as one exit node.
const pairedExitRoute = (route: string) =>
  route === "::/0" ? "0.0.0.0/0" : "::/0";
/** Pending routes with subnets first and the exit routes last, so the exit pair forms one row. */
function orderedPendingRoutes(node: HeadscaleNode) {
  const pending = nodePendingRoutes(node);
  return [
    ...pending.filter((route) => !isExitRoute(route)),
    ...pending.filter(isExitRoute),
  ];
}
export default function RoutesPage() {
  const session = useSession();
  const mounted = useRef(true);
  const notificationOwner = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function beginRouteNotification() {
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
  const { copy } = useProductCopy();
  const {
    routeNodes,
    nodeById: currentNode,
    isRefreshing,
    refreshErrors,
  } = useSnapshot();
  const [routeReadReady, setRouteReadReady] = useState(false);
  const routeRefreshError =
    !isRefreshing && (!routeReadReady || refreshErrors.fabric)
      ? refreshErrors.fabric || copy.routeRefreshRequired
      : "";
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshRoutes } =
    useSegment("fabric");
  const { isActionPending, actionError, actionOutcome, clearActionFeedback } =
    useActionFeedback();
  const navigate = useNavigate();
  const { nodeId } = useRouteIntent();
  const linkedNodeId = routeNodes.some((node) => node.id === nodeId)
    ? nodeId
    : null;
  useEffect(() => {
    if (!linkedNodeId) return;
    // One frame later: the router resets the scroll position after the navigation that opened this page.
    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById(
        `route-node-heading-${linkedNodeId}`,
      );
      heading?.scrollIntoView({ block: "center" });
      heading?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [linkedNodeId]);
  const [selectedRouteApproval, setSelectedRouteApproval] =
    useState<RouteApprovalTarget | null>(null);
  const routeApprovalDialogOpen = selectedRouteApproval !== null;
  const [selectedRoutesApprovalNode, setSelectedRoutesApprovalNode] =
    useState<HeadscaleNode | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RouteApprovalTarget | null>(
    null,
  );
  useSessionDraft(
    selectedRouteApproval !== null ||
      selectedRoutesApprovalNode !== null ||
      revokeTarget !== null,
  );
  const selectedRoutesApprovalPending = selectedRoutesApprovalNode
    ? nodePendingRoutes(selectedRoutesApprovalNode)
    : [];
  const selectedRoutesApprovalHasExitRoute =
    selectedRoutesApprovalPending.some(isExitRoute);
  const {
    nodeDisplayName,
    nodeOwner,
    hasVisibleUser,
    nodeStatusLabel,
    formatDate,
  } = useDisplayHelpers();
  const { mutateDetailed } = useMutation();
  // One guard serves all three dialogs: they are modal, every open takes a new epoch and every close cancels it.
  const routeApprovalGuard = useRefreshGuard("fabric");
  // The store is read at call time, so a write never starts from the copy a dialog was opened with.
  const latest = (node: HeadscaleNode) => currentNode(node.id) ?? node;
  function jumpToMachine(node: HeadscaleNode) {
    void navigate({
      to: "/devices",
      search: { search: nodeDisplayName(node) },
    }).catch(() => {});
  }
  function jumpToUser(user: HeadscaleUser) {
    void navigate({
      to: "/members",
      search: { user: user.id, from: "routes" },
    }).catch(() => {});
  }
  function requestApproveRoutes(node: HeadscaleNode) {
    clearActionFeedback("approve-routes");
    ++notificationOwner.current;
    const token = routeApprovalGuard.next();
    setRouteReadReady(false);
    setSelectedRoutesApprovalNode(node);
    void routeApprovalGuard.refresh(token, (fresh) => {
      if (!fresh) return;
      setRouteReadReady(true);
      const next = currentNode(node.id);
      if (next && nodePendingRoutes(next).length > 0)
        setSelectedRoutesApprovalNode(next);
      else closeApproveRoutesDialog();
    });
  }
  // The dialogs have no trigger, so Base UI only ever reports them closing.
  function closeApproveRoutesDialog() {
    if (isActionPending("approve-routes")) return;
    ++notificationOwner.current;
    routeApprovalGuard.cancel();
    setSelectedRoutesApprovalNode(null);
    clearActionFeedback("approve-routes");
  }
  async function confirmApproveRoutes(node: HeadscaleNode) {
    const notification = beginRouteNotification();
    const approved = await mutateDetailed("approve-routes", {
      endpoint: "setApprovedRoutes",
      input: {
        nodeId: node.id,
        // Only the routes the dialog displayed are newly approved; a route advertised since is never approved unseen.
        routes: Array.from(
          new Set([
            ...latest(node).approvedRoutes,
            ...selectedRoutesApprovalPending,
          ]),
        ),
      },
    });
    if (!["unknown", "possibly-applied"].includes(approved.outcome.status))
      notification.publishMutation(
        approved.outcome,
        "product.feedbackRequestConfirmed",
      );
    if (approved.ok) closeApproveRoutesDialog();
  }
  function openRouteApprovalDialog(node: HeadscaleNode, route: string) {
    clearActionFeedback("approve-route");
    ++notificationOwner.current;
    const token = routeApprovalGuard.next();
    setRouteReadReady(false);
    setSelectedRouteApproval({ node, route });
    void routeApprovalGuard.refresh(token, (fresh) => {
      if (!fresh) return;
      setRouteReadReady(true);
      const nextNode = currentNode(node.id);
      if (nextNode?.availableRoutes.includes(route))
        setSelectedRouteApproval({ node: nextNode, route });
      else closeRouteApprovalDialog();
    });
  }
  function closeRouteApprovalDialog() {
    if (isActionPending("approve-route")) return;
    ++notificationOwner.current;
    routeApprovalGuard.cancel();
    setSelectedRouteApproval(null);
    clearActionFeedback("approve-route");
  }
  async function confirmApproveRoute(target: RouteApprovalTarget) {
    const notification = beginRouteNotification();
    const approved = await mutateDetailed("approve-route", {
      endpoint: "setApprovedRoutes",
      input: {
        nodeId: target.node.id,
        routes: Array.from(
          new Set([...latest(target.node).approvedRoutes, target.route]),
        ),
      },
    });
    if (!["unknown", "possibly-applied"].includes(approved.outcome.status))
      notification.publishMutation(
        approved.outcome,
        "product.feedbackRequestConfirmed",
      );
    if (approved.ok) closeRouteApprovalDialog();
  }
  function openRevokeDialog(node: HeadscaleNode, route: string) {
    clearActionFeedback("revoke-route");
    ++notificationOwner.current;
    const token = routeApprovalGuard.next();
    setRouteReadReady(false);
    setRevokeTarget({ node, route });
    void routeApprovalGuard.refresh(token, (fresh) => {
      if (!fresh) return;
      setRouteReadReady(true);
      const next = currentNode(node.id);
      if (next?.approvedRoutes.includes(route))
        setRevokeTarget({ node: next, route });
      else closeRevokeDialog();
    });
  }
  function closeRevokeDialog() {
    if (isActionPending("revoke-route")) return;
    ++notificationOwner.current;
    routeApprovalGuard.cancel();
    setRevokeTarget(null);
    clearActionFeedback("revoke-route");
  }
  async function confirmRevoke(target: RouteApprovalTarget) {
    const fresh = latest(target.node);
    const gone = nodeRevocationTargets(fresh, target.route);
    const notification = beginRouteNotification();
    const revoked = await mutateDetailed("revoke-route", {
      endpoint: "setApprovedRoutes",
      input: {
        nodeId: target.node.id,
        routes: fresh.approvedRoutes.filter((route) => !gone.includes(route)),
      },
    });
    if (!["unknown", "possibly-applied"].includes(revoked.outcome.status))
      notification.publishMutation(
        revoked.outcome,
        "product.feedbackRequestConfirmed",
      );
    if (revoked.ok) closeRevokeDialog();
  }
  function renderRouteFeedback(
    key: "approve-route" | "approve-routes" | "revoke-route",
  ) {
    const error = actionError(key);
    if (!error && !routeRefreshError) return null;
    const outcome = actionOutcome(key);
    const uncertain =
      outcome && ["unknown", "possibly-applied"].includes(outcome.status);
    const diagnostic = (
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {copy.details}
        </summary>
        <p className="mt-2 break-words">{error}</p>
      </details>
    );
    return (
      <div className="grid gap-2" data-testid={`${key}-error`}>
        {routeRefreshError && (
          <Notice tone="error" title={copy.routeRefreshRequired}>
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                {copy.details}
              </summary>
              <p className="mt-2 break-words">{routeRefreshError}</p>
            </details>
          </Notice>
        )}
        {error &&
          (uncertain ? (
            <Notice tone="warning" title={copy.feedbackPossiblyApplied}>
              {diagnostic}
            </Notice>
          ) : (
            diagnostic
          ))}
      </div>
    );
  }
  return (
    <section className="space-y-3 sm:space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy.routesTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {copy.routesSubtitle}
          </p>
        </div>
        <Tooltip content={copy.refreshData}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="refresh-routes"
            aria-label={copy.refreshData}
            disabled={isRefreshingSnapshot}
            onClick={refreshRoutes}
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
      </div>

      <div className="grid gap-2">
        {routeNodes.map((node) => {
          const owner = hasVisibleUser(node.user) ? node.user : null;
          const pending = orderedPendingRoutes(node);
          const pendingExit = pending.filter(isExitRoute);
          // One row per subnet route and one for the whole exit pair.
          const pendingRows = pending.filter(
            (route) => !isExitRoute(route) || route === pendingExit[0],
          );
          return (
            <Card
              key={node.id}
              className="overflow-hidden data-highlighted:ring-2 data-highlighted:ring-primary"
              data-testid={`route-node-${node.id}`}
              data-highlighted={node.id === linkedNodeId || undefined}
            >
              <div className="grid gap-3 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2
                      id={`route-node-heading-${node.id}`}
                      tabIndex={-1}
                      className="font-semibold outline-none"
                      data-testid={`route-node-heading-${node.id}`}
                    >
                      <button
                        type="button"
                        className="inline-flex max-w-full items-center text-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`route-machine-link-${node.id}`}
                        aria-label={`${copy.viewMachine}: ${nodeDisplayName(node)}`}
                        onClick={() => jumpToMachine(node)}
                      >
                        <span className="truncate">
                          {nodeDisplayName(node)}
                        </span>
                      </button>
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <Badge
                        variant="outline"
                        className={nodeStatusClass(node)}
                        data-testid={`route-node-status-${node.id}`}
                      >
                        {nodeStatusLabel(node)}
                      </Badge>
                      {!node.online && (
                        <span data-testid={`route-node-last-seen-${node.id}`}>
                          {copy.lastSeen}: {formatDate(node.lastSeen)}
                        </span>
                      )}
                      <span data-testid={`route-node-expiry-${node.id}`}>
                        {copy.expires}: {formatDate(node.expiry)}
                      </span>
                    </div>
                    {owner && (
                      <button
                        type="button"
                        className="mt-1 inline-flex max-w-full text-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`route-user-link-${node.id}`}
                        aria-label={`${copy.viewUser}: ${nodeOwner(node)}`}
                        onClick={() => jumpToUser(owner)}
                      >
                        <span className="truncate">{nodeOwner(node)}</span>
                      </button>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={pending.length === 0}
                    data-testid={`approve-routes-${node.id}`}
                    onClick={() => requestApproveRoutes(node)}
                  >
                    <Router className="h-4 w-4" aria-hidden="true" />
                    {pending.length === 0
                      ? copy.routesApproved
                      : copy.approveAll}
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <p
                      className="text-xs font-medium text-muted-foreground"
                      data-testid={`route-advertised-label-${node.id}`}
                    >
                      {copy.advertisedRoutes}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {node.availableRoutes.map((route, routeIndex) => (
                        <Badge
                          key={route}
                          variant="outline"
                          className="max-w-full justify-start whitespace-normal break-all font-mono"
                          data-testid={`route-available-${node.id}-${routeIndex}`}
                        >
                          <bdi dir="ltr">{route}</bdi>
                        </Badge>
                      ))}
                      {node.availableRoutes.length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          {copy.noRouteValues}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {copy.approvedRoutes}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {node.approvedRoutes.map((route, routeIndex) => {
                        const revokeLabel = `${isExitRoute(route) ? copy.revokeExitNode : copy.revokeRoute}: ${nodeRevocationTargets(node, route).join(", ")}, ${nodeDisplayName(node)}`;
                        return (
                          <div
                            key={route}
                            className="inline-flex max-w-full items-center gap-0.5"
                          >
                            <Badge
                              variant="secondary"
                              className="max-w-full justify-start whitespace-normal break-all font-mono"
                              data-testid={`route-approved-${node.id}-${routeIndex}`}
                            >
                              <bdi dir="ltr">{route}</bdi>
                            </Badge>
                            <Tooltip content={revokeLabel}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                data-testid={`revoke-route-${node.id}-${routeIndex}`}
                                aria-label={revokeLabel}
                                onClick={() => openRevokeDialog(node, route)}
                              >
                                <X aria-hidden="true" className="h-3.5 w-3.5" />
                              </Button>
                            </Tooltip>
                          </div>
                        );
                      })}
                      {node.approvedRoutes.length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          {copy.noRouteValues}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {pendingRows.length > 0 && (
                  <div
                    className="overflow-hidden rounded-md border bg-background/45"
                    data-testid={`pending-routes-list-${node.id}`}
                  >
                    {pendingRows.map((route, routeIndex) => (
                      <div
                        key={route}
                        className="grid gap-2 border-t px-3 py-2 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                        data-testid={`pending-route-${node.id}-${routeIndex}`}
                      >
                        <Badge
                          variant={
                            isExitRoute(route) ? "destructive" : "outline"
                          }
                          className="justify-self-start"
                        >
                          {isExitRoute(route)
                            ? copy.exitNode
                            : copy.pendingRoutes}
                        </Badge>
                        <div className="flex min-w-0 flex-wrap gap-1.5">
                          {(isExitRoute(route) ? pendingExit : [route]).map(
                            (value) => (
                              <Badge
                                key={value}
                                variant="secondary"
                                className="max-w-full whitespace-normal break-all font-mono"
                                data-testid={`pending-route-value-${node.id}-${pending.indexOf(value)}`}
                              >
                                <bdi dir="ltr">{value}</bdi>
                              </Badge>
                            ),
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            "justify-self-start sm:justify-self-end",
                            isExitRoute(route)
                              ? "border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              : undefined,
                          )}
                          data-testid={`approve-route-${node.id}-${routeIndex}`}
                          onClick={() => openRouteApprovalDialog(node, route)}
                        >
                          <Router className="h-4 w-4" aria-hidden="true" />
                          {isExitRoute(route)
                            ? copy.approveExitNode
                            : copy.approveRoute}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
        {routeNodes.length === 0 && (
          <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
            {copy.noRoutes}
          </p>
        )}
      </div>

      <AlertDialog
        open={routeApprovalDialogOpen}
        onOpenChange={closeRouteApprovalDialog}
      >
        {selectedRouteApproval && (
          <AlertDialogContent data-testid="approve-route-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isExitRoute(selectedRouteApproval.route)
                  ? copy.approveExitNode
                  : copy.approveRouteTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isExitRoute(selectedRouteApproval.route)
                  ? copy.approveExitRouteDescription
                  : copy.approveRouteDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="text-muted-foreground">
                {nodeDisplayName(selectedRouteApproval.node)}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 break-all font-medium">
                <bdi dir="ltr" data-testid="approve-route-target">
                  {selectedRouteApproval.route}
                </bdi>
                {isExitRoute(selectedRouteApproval.route) && (
                  <bdi dir="ltr" data-testid="approve-route-paired">
                    {pairedExitRoute(selectedRouteApproval.route)}
                  </bdi>
                )}
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="approve-route-cancel"
                disabled={isActionPending("approve-route")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              {routeRefreshError && (
                <Button
                  variant="outline"
                  data-testid="approve-route-retry"
                  disabled={isActionPending("approve-route")}
                  onClick={() =>
                    openRouteApprovalDialog(
                      selectedRouteApproval.node,
                      selectedRouteApproval.route,
                    )
                  }
                >
                  {copy.refreshData}
                </Button>
              )}
              <Button
                variant={
                  isExitRoute(selectedRouteApproval.route)
                    ? "destructive"
                    : "default"
                }
                data-testid="approve-route-confirm"
                disabled={
                  isActionPending("approve-route") ||
                  isRefreshing ||
                  !routeReadReady ||
                  Boolean(refreshErrors.fabric)
                }
                onClick={() => confirmApproveRoute(selectedRouteApproval)}
              >
                {isActionPending("approve-route") ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Router className="h-4 w-4" aria-hidden="true" />
                )}
                {isExitRoute(selectedRouteApproval.route)
                  ? copy.approveExitNode
                  : copy.approveRoute}
              </Button>
            </AlertDialogFooter>
            {renderRouteFeedback("approve-route")}
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={Boolean(selectedRoutesApprovalNode)}
        onOpenChange={closeApproveRoutesDialog}
      >
        {selectedRoutesApprovalNode && (
          <AlertDialogContent data-testid="approve-routes-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {selectedRoutesApprovalHasExitRoute
                  ? copy.approveExitRoutesTitle
                  : copy.approveRoutesTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {selectedRoutesApprovalHasExitRoute
                  ? copy.approveExitRoutesDescription
                  : copy.approveRoutesDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
              <p className="text-sm font-medium">
                {nodeDisplayName(selectedRoutesApprovalNode)}
              </p>
              {selectedRoutesApprovalPending.map((route, routeIndex) => (
                <Badge
                  key={route}
                  variant="outline"
                  className={cn(
                    "w-fit max-w-full whitespace-normal break-all font-mono",
                    pendingRouteClass(route),
                  )}
                  data-testid={`approve-routes-target-${routeIndex}`}
                >
                  <bdi dir="ltr">{route}</bdi>
                </Badge>
              ))}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="approve-routes-cancel"
                disabled={isActionPending("approve-routes")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              {routeRefreshError && (
                <Button
                  variant="outline"
                  data-testid="approve-routes-retry"
                  disabled={isActionPending("approve-routes")}
                  onClick={() =>
                    requestApproveRoutes(selectedRoutesApprovalNode)
                  }
                >
                  {copy.refreshData}
                </Button>
              )}
              <Button
                type="button"
                variant={
                  selectedRoutesApprovalHasExitRoute ? "destructive" : "default"
                }
                data-testid="approve-routes-confirm"
                disabled={
                  isActionPending("approve-routes") ||
                  isRefreshing ||
                  !routeReadReady ||
                  Boolean(refreshErrors.fabric)
                }
                onClick={() => confirmApproveRoutes(selectedRoutesApprovalNode)}
              >
                {isActionPending("approve-routes") ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Router className="h-4 w-4" aria-hidden="true" />
                )}
                {copy.confirmApproveRoutes}
              </Button>
            </AlertDialogFooter>
            {renderRouteFeedback("approve-routes")}
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={closeRevokeDialog}
      >
        {revokeTarget && (
          <AlertDialogContent data-testid="revoke-route-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isExitRoute(revokeTarget.route)
                  ? copy.revokeExitNode
                  : copy.revokeRouteTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isExitRoute(revokeTarget.route)
                  ? copy.revokeExitRouteDescription
                  : copy.revokeRouteDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
              <p className="text-sm font-medium">
                {nodeDisplayName(revokeTarget.node)}
              </p>
              {nodeRevocationTargets(revokeTarget.node, revokeTarget.route).map(
                (route, index) => (
                  <Badge
                    key={route}
                    variant="outline"
                    className={cn(
                      "w-fit max-w-full whitespace-normal break-all font-mono",
                      pendingRouteClass(route),
                    )}
                    data-testid={`revoke-route-target-${index}`}
                  >
                    <bdi dir="ltr">{route}</bdi>
                  </Badge>
                ),
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="revoke-route-cancel"
                disabled={isActionPending("revoke-route")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              {routeRefreshError && (
                <Button
                  variant="outline"
                  data-testid="revoke-route-retry"
                  disabled={isActionPending("revoke-route")}
                  onClick={() =>
                    openRevokeDialog(revokeTarget.node, revokeTarget.route)
                  }
                >
                  {copy.refreshData}
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                data-testid="revoke-route-confirm"
                disabled={
                  isActionPending("revoke-route") ||
                  isRefreshing ||
                  !routeReadReady ||
                  Boolean(refreshErrors.fabric)
                }
                onClick={() => confirmRevoke(revokeTarget)}
              >
                {isActionPending("revoke-route") ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <X className="h-4 w-4" aria-hidden="true" />
                )}
                {isExitRoute(revokeTarget.route)
                  ? copy.revokeExitNode
                  : copy.revokeRoute}
              </Button>
            </AlertDialogFooter>
            {renderRouteFeedback("revoke-route")}
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  );
}
