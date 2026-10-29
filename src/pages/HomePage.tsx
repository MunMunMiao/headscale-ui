import { Link } from "@tanstack/react-router";
import { LoaderCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDisplayHelpers } from "@/composables/useDisplayHelpers";
import { useProductCopy } from "@/composables/useProductCopy";
import { useSnapshot } from "@/composables/useSnapshot";
import { cn } from "@/lib/utils";
import { nodeStatusClass } from "@/utils/status-class";

export default function HomePage() {
  const { copy } = useProductCopy();
  const {
    snapshot,
    onlineNodes,
    openInvites,
    isRefreshing: isRefreshingSnapshot,
    refreshByUser,
  } = useSnapshot();
  const { nodeDisplayName, nodeOwner, nodeStatusLabel, hasVisibleUser } =
    useDisplayHelpers();
  const routesWaiting = snapshot.nodes.reduce(
    (total, node) =>
      total +
      node.availableRoutes.filter(
        (route) => !node.approvedRoutes.includes(route),
      ).length,
    0,
  );
  const visibleUsers = snapshot.users.filter((user) => hasVisibleUser(user));
  // Headscale ids grow with registration; createdAt is optional, so order by id.
  const recentNodes = [...snapshot.nodes]
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
    .slice(0, 4);
  const stats = [
    {
      id: "online",
      to: "/devices",
      label: copy.onlineDevices,
      value: onlineNodes.length,
    },
    {
      id: "total",
      to: "/devices",
      label: copy.totalDevices,
      value: snapshot.nodes.length,
    },
    {
      id: "users",
      to: "/members",
      label: copy.nav.members,
      value: visibleUsers.length,
    },
    {
      id: "invites",
      to: "/invites",
      label: copy.openInvites,
      value: openInvites.length,
    },
    // Only routes still waiting for approval are counted.
    {
      id: "routes",
      to: "/routes",
      label: copy.pendingRoutes,
      value: routesWaiting,
    },
  ];
  const linkClass =
    "min-w-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <section className="space-y-2 sm:space-y-3 lg:space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 lg:flex lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">
            {copy.dashboardTitle}
          </h1>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground sm:mt-1 sm:text-sm">
            {copy.dashboardSubtitle}
          </p>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          data-testid="refresh-data"
          aria-label={copy.refreshData}
          title={copy.refreshData}
          className="sm:h-9 sm:w-fit sm:px-3"
          disabled={isRefreshingSnapshot}
          onClick={() => void refreshByUser()}
        >
          {isRefreshingSnapshot ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="sr-only sm:not-sr-only">{copy.refreshData}</span>
        </Button>
      </div>

      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
        data-testid="overview-stats"
      >
        {stats.map((stat) => (
          <Link
            key={stat.id}
            to={stat.to}
            search={
              stat.id === "online"
                ? { filter: "online" }
                : stat.id === "invites"
                  ? { filter: "ready" }
                  : {}
            }
            className={cn(
              linkClass,
              stat.id === "routes" && "col-span-2 sm:col-span-1",
            )}
            data-testid={`overview-stat-${stat.id}`}
          >
            <Card className="h-full p-2.5 transition-colors hover:bg-muted/40 sm:p-3">
              <div className="flex min-w-0 items-center justify-between gap-2 sm:block">
                <p className="min-w-0 text-xs leading-4 text-muted-foreground sm:text-sm">
                  {stat.label}
                </p>
                <p className="shrink-0 text-xl font-semibold leading-none tabular-nums sm:mt-1 sm:text-2xl">
                  {stat.value}
                </p>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      <div>
        <h2
          className="mb-2 text-sm font-semibold sm:mb-3 sm:text-base"
          data-testid="recent-devices-heading"
        >
          {copy.recentDevices}
        </h2>
        {snapshot.nodes.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="recent-devices-empty"
          >
            {copy.addFirstDeviceDescription}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {recentNodes.map((node) => (
              <Link
                key={node.id}
                to="/devices"
                search={{ search: nodeDisplayName(node) }}
                className={linkClass}
                data-testid={`recent-device-${node.id}`}
              >
                <Card className="h-full p-3 transition-colors hover:bg-muted/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="truncate font-medium"
                        title={nodeDisplayName(node)}
                      >
                        {nodeDisplayName(node)}
                      </p>
                      {hasVisibleUser(node.user) && (
                        <p
                          className="truncate text-sm text-muted-foreground"
                          title={nodeOwner(node)}
                        >
                          {nodeOwner(node)}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn("shrink-0", nodeStatusClass(node))}
                      data-testid={`recent-device-status-${node.id}`}
                    >
                      {node.online ? (
                        <Wifi className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <WifiOff className="h-3 w-3" aria-hidden="true" />
                      )}
                      {nodeStatusLabel(node)}
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
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
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
