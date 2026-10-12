import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, RefreshCw, Router, X } from "lucide-react";
import { useState } from "react";
import * as endpoints from "@/api/commands";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
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
import { useActionFeedback } from "@/composables/useActionFeedback";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useMutation } from "@/composables/useMutation";
import { useProductCopy } from "@/composables/useProductCopy";
import { useRefreshGuard } from "@/composables/useRefreshGuard";
import { useSessionDraft } from "@/composables/useSessionDraft";
import { useSnapshot } from "@/composables/useSnapshot";
import { useSegment } from "@/composables/useSnapshotSegment";
import { cn } from "@/lib/utils";
import { nodePendingRoutes, nodeRevocationTargets } from "@/utils/node";
import { isExitRoute, pendingRouteClass } from "@/utils/status-class";

type RouteApprovalTarget = { node: HeadscaleNode; route: string };
export default function RoutesPage() {
  const { copy } = useProductCopy();
  const { routeNodes, nodeById: currentNode, isRefreshing } = useSnapshot();
  const { isRefreshing: isRefreshingSnapshot, refresh: refreshRoutes } = useSegment("fabric");
  const { isActionPending, actionError, clearActionFeedback } = useActionFeedback();
  const navigate = useNavigate();
  const [selectedRouteApproval, setSelectedRouteApproval] = useState<RouteApprovalTarget | null>(
    null,
  );
  const routeApprovalDialogOpen = selectedRouteApproval !== null;
  const [selectedRoutesApprovalNode, setSelectedRoutesApprovalNode] =
    useState<HeadscaleNode | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<RouteApprovalTarget | null>(null);
  useSessionDraft(
    selectedRouteApproval !== null || selectedRoutesApprovalNode !== null || revokeTarget !== null,
  );
  const selectedRoutesApprovalPending = selectedRoutesApprovalNode
    ? nodePendingRoutes(selectedRoutesApprovalNode)
    : [];
  const selectedRoutesApprovalHasExitRoute = selectedRoutesApprovalPending.some(isExitRoute);
  const { nodeDisplayName, nodeOwner, hasVisibleUser } = useDisplayHelpers();
  const { mutate } = useMutation();
  // One guard serves all three dialogs: they are modal, every open takes a new epoch and every close cancels it.
  const routeApprovalGuard = useRefreshGuard();
  // The store is read at call time, so a write never starts from the copy a dialog was opened with.
  const latest = (node: HeadscaleNode) => currentNode(node.id) ?? node;
  function jumpToMachine(node: HeadscaleNode) {
    void navigate({ to: "/devices", search: { search: nodeDisplayName(node) } }).catch(() => {});
  }
  function jumpToUser(user: HeadscaleUser) {
    void navigate({ to: "/members", search: { user: user.id, from: "routes" } }).catch(() => {});
  }
  function requestApproveRoutes(node: HeadscaleNode) {
    clearActionFeedback("approve-routes");
    const token = routeApprovalGuard.next();
    setSelectedRoutesApprovalNode(node);
    void routeApprovalGuard.refresh(token, () => {
      const next = currentNode(node.id);
      if (next && nodePendingRoutes(next).length > 0) setSelectedRoutesApprovalNode(next);
      else closeApproveRoutesDialog();
    });
  }
  // The dialogs have no trigger, so Base UI only ever reports them closing.
  function closeApproveRoutesDialog() {
    if (isActionPending("approve-routes")) return;
    routeApprovalGuard.cancel();
    setSelectedRoutesApprovalNode(null);
    clearActionFeedback("approve-routes");
  }
  async function confirmApproveRoutes(node: HeadscaleNode) {
    const approved = await mutate(
      "approve-routes",
      endpoints.setApprovedRoutes({
        nodeId: node.id,
        // Only the routes the dialog displayed are newly approved; a route advertised since is never approved unseen.
        routes: Array.from(
          new Set([...latest(node).approvedRoutes, ...selectedRoutesApprovalPending]),
        ),
      }),
    );
    if (approved) closeApproveRoutesDialog();
  }
  function openRouteApprovalDialog(node: HeadscaleNode, route: string) {
    clearActionFeedback("approve-route");
    const token = routeApprovalGuard.next();
    setSelectedRouteApproval({ node, route });
    void routeApprovalGuard.refresh(token, () => {
      const nextNode = currentNode(node.id);
      if (nextNode?.availableRoutes.includes(route))
        setSelectedRouteApproval({ node: nextNode, route });
      else closeRouteApprovalDialog();
    });
  }
  function closeRouteApprovalDialog() {
    if (isActionPending("approve-route")) return;
    routeApprovalGuard.cancel();
    setSelectedRouteApproval(null);
    clearActionFeedback("approve-route");
  }
  async function confirmApproveRoute(target: RouteApprovalTarget) {
    const approved = await mutate(
      "approve-route",
      endpoints.setApprovedRoutes({
        nodeId: target.node.id,
        routes: Array.from(new Set([...latest(target.node).approvedRoutes, target.route])),
      }),
    );
    if (approved) closeRouteApprovalDialog();
  }
  function openRevokeDialog(node: HeadscaleNode, route: string) {
    clearActionFeedback("revoke-route");
    const token = routeApprovalGuard.next();
    setRevokeTarget({ node, route });
    void routeApprovalGuard.refresh(token, () => {
      const next = currentNode(node.id);
      if (next?.approvedRoutes.includes(route)) setRevokeTarget({ node: next, route });
      else closeRevokeDialog();
    });
  }
  function closeRevokeDialog() {
    if (isActionPending("revoke-route")) return;
    routeApprovalGuard.cancel();
    setRevokeTarget(null);
    clearActionFeedback("revoke-route");
  }
  async function confirmRevoke(target: RouteApprovalTarget) {
    const fresh = latest(target.node);
    const gone = nodeRevocationTargets(fresh, target.route);
    const revoked = await mutate(
      "revoke-route",
      endpoints.setApprovedRoutes({
        nodeId: target.node.id,
        routes: fresh.approvedRoutes.filter((route) => !gone.includes(route)),
      }),
    );
    if (revoked) closeRevokeDialog();
  }
  return (
    <section className="space-y-3 sm:space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{copy.routesTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.routesSubtitle}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          data-testid="refresh-routes"
          aria-label={copy.refreshData}
          title={copy.refreshData}
          disabled={isRefreshingSnapshot}
          onClick={refreshRoutes}
        >
          {isRefreshingSnapshot ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      <div className="grid gap-2">
        {routeNodes.map((node) => {
          const owner = hasVisibleUser(node.user) ? node.user : null;
          return (
            <Card key={node.id} className="overflow-hidden" data-testid={`route-node-${node.id}`}>
              <div className="grid gap-3 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      <button
                        type="button"
                        className="inline-flex max-w-full items-center text-start underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`route-machine-link-${node.id}`}
                        aria-label={`${copy.viewMachine}: ${nodeDisplayName(node)}`}
                        onClick={() => jumpToMachine(node)}
                      >
                        <span className="truncate">{nodeDisplayName(node)}</span>
                      </button>
                    </h2>
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
                    disabled={nodePendingRoutes(node).length === 0}
                    data-testid={`approve-routes-${node.id}`}
                    onClick={() => requestApproveRoutes(node)}
                  >
                    <Router className="h-4 w-4" aria-hidden="true" />
                    {nodePendingRoutes(node).length === 0 ? copy.routesApproved : copy.approveAll}
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {copy.availableRoutes}
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
                        <span className="text-xs text-muted-foreground">{copy.noRouteValues}</span>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {copy.approvedRoutes}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {node.approvedRoutes.map((route, routeIndex) => (
                        <div key={route} className="inline-flex max-w-full items-center gap-0.5">
                          <Badge
                            variant="secondary"
                            className="max-w-full justify-start whitespace-normal break-all font-mono"
                            data-testid={`route-approved-${node.id}-${routeIndex}`}
                          >
                            <bdi dir="ltr">{route}</bdi>
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            data-testid={`revoke-route-${node.id}-${routeIndex}`}
                            aria-label={`${copy.revokeRoute}: ${route}, ${nodeDisplayName(node)}`}
                            title={`${copy.revokeRoute}: ${route}, ${nodeDisplayName(node)}`}
                            onClick={() => openRevokeDialog(node, route)}
                          >
                            <X aria-hidden="true" className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                      {node.approvedRoutes.length === 0 && (
                        <span className="text-xs text-muted-foreground">{copy.noRouteValues}</span>
                      )}
                    </div>
                  </div>
                </div>

                {nodePendingRoutes(node).length > 0 && (
                  <div
                    className="overflow-hidden rounded-md border bg-background/45"
                    data-testid={`pending-routes-list-${node.id}`}
                  >
                    {nodePendingRoutes(node).map((route, routeIndex) => (
                      <div
                        key={route}
                        className="grid gap-2 border-t px-3 py-2 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                        data-testid={`pending-route-${node.id}-${routeIndex}`}
                      >
                        <Badge
                          variant={isExitRoute(route) ? "destructive" : "outline"}
                          className="justify-self-start"
                        >
                          {isExitRoute(route) ? copy.exitRoute : copy.pendingRoutes}
                        </Badge>
                        <Badge
                          variant="secondary"
                          className="max-w-full justify-self-start whitespace-normal break-all font-mono"
                          data-testid={`pending-route-value-${node.id}-${routeIndex}`}
                        >
                          <bdi dir="ltr">{route}</bdi>
                        </Badge>
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
                          {copy.approveRoute}
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

      <AlertDialog open={routeApprovalDialogOpen} onOpenChange={closeRouteApprovalDialog}>
        {selectedRouteApproval && (
          <AlertDialogContent data-testid="approve-route-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isExitRoute(selectedRouteApproval.route)
                  ? copy.approveExitRouteTitle
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
              <div className="mt-1 break-all font-medium" data-testid="approve-route-target">
                <bdi dir="ltr">{selectedRouteApproval.route}</bdi>
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="approve-route-cancel"
                disabled={isActionPending("approve-route")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                variant={isExitRoute(selectedRouteApproval.route) ? "destructive" : "default"}
                data-testid="approve-route-confirm"
                disabled={isActionPending("approve-route") || isRefreshing}
                onClick={() => confirmApproveRoute(selectedRouteApproval)}
              >
                {isActionPending("approve-route") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Router className="h-4 w-4" aria-hidden="true" />
                )}
                {copy.approveRoute}
              </Button>
            </AlertDialogFooter>
            {actionError("approve-route") && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="approve-route-error"
              >
                {actionError("approve-route")}
              </p>
            )}
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
              <p className="text-sm font-medium">{nodeDisplayName(selectedRoutesApprovalNode)}</p>
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
              <Button
                type="button"
                variant={selectedRoutesApprovalHasExitRoute ? "destructive" : "default"}
                data-testid="approve-routes-confirm"
                disabled={isActionPending("approve-routes") || isRefreshing}
                onClick={() => confirmApproveRoutes(selectedRoutesApprovalNode)}
              >
                {isActionPending("approve-routes") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Router className="h-4 w-4" aria-hidden="true" />
                )}
                {copy.confirmApproveRoutes}
              </Button>
            </AlertDialogFooter>
            {actionError("approve-routes") && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="approve-routes-error"
              >
                {actionError("approve-routes")}
              </p>
            )}
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog open={revokeTarget !== null} onOpenChange={closeRevokeDialog}>
        {revokeTarget && (
          <AlertDialogContent data-testid="revoke-route-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.revokeRouteTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {isExitRoute(revokeTarget.route)
                  ? copy.revokeExitRouteDescription
                  : copy.revokeRouteDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2 rounded-md border bg-muted/30 p-3">
              <p className="text-sm font-medium">{nodeDisplayName(revokeTarget.node)}</p>
              {nodeRevocationTargets(revokeTarget.node, revokeTarget.route).map((route, index) => (
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
              ))}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="revoke-route-cancel"
                disabled={isActionPending("revoke-route")}
              >
                {copy.cancel}
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                data-testid="revoke-route-confirm"
                disabled={isActionPending("revoke-route") || isRefreshing}
                onClick={() => confirmRevoke(revokeTarget)}
              >
                {isActionPending("revoke-route") ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <X className="h-4 w-4" aria-hidden="true" />
                )}
                {copy.revokeRoute}
              </Button>
            </AlertDialogFooter>
            {actionError("revoke-route") && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="revoke-route-error"
              >
                {actionError("revoke-route")}
              </p>
            )}
          </AlertDialogContent>
        )}
      </AlertDialog>
    </section>
  );
}
