import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { Notice } from "@/components/app/notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useSession, useStore } from "@/composables/session-context";
import type { LifecycleScope } from "@/composables/tag-lifecycle-state";
import { useProductCopy } from "@/composables/useProductCopy";
import { useSnapshot } from "@/composables/useSnapshot";
import { isPolicyIdentityName, parsePolicy } from "@/domain/policy-designer";
import { policyAliases } from "@/domain/policy-references";
import { withTagPrefix } from "@/domain/policy-views";
import {
  observeTags,
  replaceTagInSet,
  tagOwnerDependencies,
} from "@/domain/tag-lifecycle";
import { isNodeTag, nodeDisplayName } from "@/utils/node";

/** A projection of current resources, not a saved task or a background executor. */
export default function AccessTagMaintenance({
  tag,
  readOnly,
  onClose,
  onEdit,
  onPrepare,
}: {
  tag: string;
  readOnly: boolean;
  onClose: () => void;
  onEdit: (tag: string) => void;
  onPrepare: (tag: string) => void;
}) {
  const { copy } = useProductCopy();
  const session = useSession();
  const navigate = useNavigate();
  const { snapshot, segmentStatus } = useSnapshot();
  const lifecycle = useStore(session.tagLifecycle);
  const policy = useStore(session.policy);
  const inventory = observeTags({ ...snapshot, readState: segmentStatus });
  const readback = parsePolicy(snapshot.policy?.policy ?? "");
  const [mode, setMode] = useState<"migrate" | "stop" | "retire">("migrate");
  const savedDraft =
    lifecycle.maintenanceDraft?.tag === tag ? lifecycle.maintenanceDraft : null;
  const [intent, setIntent] = useState<"new" | "existing">(
    savedDraft?.intent ?? "new",
  );
  const [targetInput, setTargetInput] = useState(savedDraft?.targetInput ?? "");
  useEffect(() => {
    session.tagLifecycle.rememberMaintenance({ tag, intent, targetInput });
  }, [session.tagLifecycle, tag, intent, targetInput]);
  const [freshScope, setFreshScope] = useState<LifecycleScope | null>(null);
  const [reading, setReading] = useState(false);
  const [external, setExternal] = useState(false);
  const active = useRef(true);
  const target = withTagPrefix(targetInput);
  const source = inventory.tags.find((entry) => entry.tag === tag);
  const destination = inventory.tags.find((entry) => entry.tag === target);
  const known =
    freshScope !== null &&
    lifecycle.isCurrent(freshScope) &&
    !reading &&
    inventory.unknownSources.length === 0 &&
    Object.values(segmentStatus).every((status) => status === "ready");
  const occupied =
    Boolean(destination) ||
    policyAliases(policy.policyDesignerState).has(target);
  const applicable =
    target !== tag && isPolicyIdentityName(target, "tag") && isNodeTag(target);
  const targetReady =
    known &&
    applicable &&
    (intent === "existing"
      ? inventory.assignableTags.includes(target)
      : !occupied);
  const targetDeclared =
    known && applicable && inventory.assignableTags.includes(target);
  const retirementClear =
    known &&
    source?.definition !== "declared" &&
    !source?.nodeIds.length &&
    !source?.referencePaths.length &&
    !source?.keys.some(
      (entry) =>
        entry.registration === "available" || entry.registration === "unknown",
    );
  const signature = JSON.stringify({
    source,
    destination,
    policy: snapshot.policy?.policy,
    mode,
    intent,
    target,
  });

  // Any newly observed dependency revokes the external acknowledgement; no completion flags survive reopening.
  // signature contains the decision fields, not online/lastSeen noise.
  useEffect(() => setExternal(false), [signature]);
  // Called on mount or by the enabled Refresh button; concurrent refreshes are superseded by the store.
  async function refresh(explicit = false) {
    const scope = lifecycle.captureScope();
    const notification = explicit
      ? session.feedback.beginNotification({
          isCurrent: () => active.current && lifecycle.isCurrent(scope),
        })
      : null;
    setReading(true);
    setFreshScope(null);
    setExternal(false);
    const success = await session.snapshot.refreshSegments([
      "policy",
      "fabric",
      "identity",
    ]);
    if (!active.current) return;
    setReading(false);
    if (success && lifecycle.isCurrent(scope)) setFreshScope(scope);
    else if (!success)
      notification?.publish({
        tone: "error",
        title: "product.feedbackRefreshFailed",
      });
  }
  // one inventory read per mounted maintenance context; later reads are explicit.
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, []);

  const inviteLink = (name: string) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={`maintenance-invites-${name}`}
      onClick={() => void navigate({ to: "/invites", search: { tag: name } })}
    >
      {copy.policyViewInvites}
    </Button>
  );
  const keyStatus = (status: string) =>
    status === "available"
      ? copy.inviteRegistrationReady
      : status === "expired"
        ? copy.inviteRegistrationExpired
        : status === "exhausted"
          ? copy.inviteRegistrationUsed
          : copy.unknown;
  const relevantNodes = snapshot.nodes.filter(
    (node) => node.tags.includes(tag) || (target && node.tags.includes(target)),
  );
  const relevantKeys = [
    ...new Map(
      [...(source?.keys ?? []), ...(destination?.keys ?? [])].map((entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="sm:max-w-3xl"
        data-testid="tag-maintenance-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {copy.policyMaintenance} · <bdi dir="auto">{tag}</bdi>
          </DialogTitle>
          <DialogDescription>{copy.policyInventoryReadback}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={mode === "migrate" ? "default" : "outline"}
            data-testid="tag-maintenance-migrate"
            onClick={() => setMode("migrate")}
          >
            {copy.policyMigrate}
          </Button>
          <Button
            type="button"
            variant={mode === "stop" ? "default" : "outline"}
            data-testid="tag-maintenance-stop"
            onClick={() => setMode("stop")}
          >
            {copy.policyStopEntrances}
          </Button>
          <Button
            type="button"
            variant={mode === "retire" ? "default" : "outline"}
            data-testid="tag-maintenance-retire"
            onClick={() => setMode("retire")}
          >
            {copy.policyRetirement}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={reading}
            data-testid="tag-maintenance-refresh"
            onClick={() => void refresh(true)}
          >
            {copy.policyInventoryRefresh}
          </Button>
        </div>
        {!known && (
          <div data-testid="tag-inventory-unknown">
            <Notice tone="warning" title={copy.policyInventoryUnknownTitle}>
              <details>
                <summary className="cursor-pointer">{copy.details}</summary>
                <p className="mt-1 text-muted-foreground">
                  {copy.policyInventoryUnknown}{" "}
                  {inventory.unknownSources.join(", ")}
                </p>
              </details>
            </Notice>
          </div>
        )}
        {inventory.referenceIssues.length > 0 && (
          <pre
            dir="ltr"
            className="overflow-auto whitespace-pre-wrap break-all text-xs"
          >
            {inventory.referenceIssues.join("\n")}
          </pre>
        )}
        {mode === "migrate" && (
          <section className="grid gap-3" data-testid="tag-migration">
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="sr-only">{copy.policyMigrate}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="tag-migration-intent"
                  checked={intent === "new"}
                  onChange={() => setIntent("new")}
                  data-testid="tag-migration-new"
                />
                {copy.policyMigrationNew}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="tag-migration-intent"
                  checked={intent === "existing"}
                  onChange={() => setIntent("existing")}
                  data-testid="tag-migration-existing"
                />
                {copy.policyMigrationExisting}
              </label>
            </fieldset>
            <label
              htmlFor="tag-migration-target"
              className="grid gap-1 text-sm"
            >
              {copy.policyMigrationTarget}
              <Input
                dir="ltr"
                id="tag-migration-target"
                data-testid="tag-migration-target"
                value={targetInput}
                onChange={(event) => setTargetInput(event.target.value)}
              />
            </label>
            {target && !targetReady && (
              <p
                data-testid="tag-migration-target-error"
                className="text-sm text-muted-foreground"
              >
                {intent === "new" && occupied
                  ? copy.policyMigrationOccupied
                  : copy.policyMigrationMissing}
              </p>
            )}
            <Notice tone="info">
              <p>{copy.policyMigrationReview}</p>
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer">{copy.details}</summary>
                <p className="mt-1 text-muted-foreground">
                  {copy.policyMigrationSequence}
                </p>
              </details>
            </Notice>
            {intent === "new" && (
              <Button
                type="button"
                data-testid="tag-migration-prepare"
                className="h-auto min-h-9 whitespace-normal text-start"
                disabled={readOnly || !targetReady}
                onClick={() => onPrepare(target)}
              >
                {copy.policyMigrationPrepare}
              </Button>
            )}
            {destination && (
              <section
                className="grid gap-1 rounded-md border p-3"
                data-testid="tag-migration-target-inventory"
              >
                <h3 className="font-medium">
                  <bdi dir="auto">{target}</bdi>
                </h3>
                <p className="text-xs">{copy.policyOwnerDependencies}</p>
                <ul className="text-xs">
                  {tagOwnerDependencies(readback, target).map((entry) => (
                    <li key={JSON.stringify(entry.path)}>
                      <bdi dir="auto">{entry.path.join(" → ")}</bdi>
                    </li>
                  ))}
                </ul>
                <pre
                  dir="ltr"
                  className="overflow-auto whitespace-pre-wrap break-all text-xs"
                >
                  {JSON.stringify(
                    {
                      owners: readback.tagOwners
                        .find((entry) => entry.tag === target)
                        ?.owners.map((entry) => entry.value),
                      references: destination.referencePaths,
                      devices: destination.nodeIds,
                      invitations: destination.keys,
                    },
                    null,
                    2,
                  )}
                </pre>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => onEdit(target)}
                >
                  {copy.tagDetailDialogTitle}
                </Button>
              </section>
            )}
            <p className="text-xs text-muted-foreground">
              {copy.policyMigrationPreserve}
            </p>
          </section>
        )}
        {mode === "stop" && (
          <section className="grid gap-2" data-testid="tag-stop-entrances">
            <p className="text-sm">{copy.policyStopScope}</p>
            <ul className="text-xs">
              {tagOwnerDependencies(readback, tag).map((entry) => (
                <li key={JSON.stringify(entry.path)}>
                  <bdi dir="auto">{entry.path.join(" → ")}</bdi>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              data-testid="tag-stop-review-owners"
              className="h-auto min-h-9 whitespace-normal text-start"
              disabled={readOnly || !isPolicyIdentityName(tag, "tag")}
              onClick={() => onEdit(tag)}
            >
              {copy.tagOwnersSection}
            </Button>
          </section>
        )}
        <section className="grid gap-2" data-testid="tag-resource-inventory">
          <h3 className="font-medium">{copy.policyObservedNodes}</h3>
          {relevantNodes.map((node) => {
            const proposedTags =
              mode === "migrate" && targetDeclared
                ? replaceTagInSet(node.tags, tag, target)
                : node.tags;
            const observedTarget = Boolean(
              targetDeclared &&
              !node.tags.includes(tag) &&
              node.tags.includes(target),
            );
            return (
              <div
                key={node.id}
                className="grid gap-2 rounded-md border p-3 text-sm"
                data-testid={`tag-migration-node-${node.id}`}
              >
                <bdi dir="auto">
                  {nodeDisplayName(node)} · {node.id}
                </bdi>
                <p dir="ltr" className="break-all">
                  {node.tags.join(", ")}
                  {mode === "migrate" &&
                    targetDeclared &&
                    node.tags.includes(tag) && (
                      <> → {proposedTags.join(", ")}</>
                    )}
                </p>
                <p className="text-xs">
                  {observedTarget
                    ? copy.policyMigrationObserved
                    : copy.policyViewDevice}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`tag-migration-open-node-${node.id}`}
                  onClick={() =>
                    void navigate({
                      to: "/devices",
                      search: {
                        node: node.id,
                        popup: "tags",
                        from: "access",
                        maintenance: tag,
                        ...(mode === "migrate" &&
                        targetDeclared &&
                        node.tags.includes(tag)
                          ? { migrateFrom: tag, migrateTo: target }
                          : {}),
                      },
                    })
                  }
                >
                  {copy.policyViewDevice}
                </Button>
              </div>
            );
          })}
          <h3 className="font-medium">{copy.policyObservedKeys}</h3>
          {relevantKeys.map((entry) => {
            const { id } = entry;
            const key = snapshot.preAuthKeys.find((key) => key.id === id);
            return (
              <div
                key={id}
                className="grid gap-1 rounded-md border p-3 text-sm"
                data-testid={`tag-maintenance-key-${id}`}
              >
                <bdi dir="auto">{id}</bdi>
                <p>{keyStatus(entry.registration)}</p>
                <p dir="ltr" className="break-all">
                  {key?.aclTags.join(", ")}
                </p>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {copy.policyKeyDeployment}
          </p>
          <div className="flex flex-wrap gap-2">
            {inviteLink(tag)}
            {target && target !== tag && inviteLink(target)}
          </div>
          <h3 className="font-medium">{copy.policyObservedReferences}</h3>
          <pre
            dir="ltr"
            className="overflow-auto whitespace-pre-wrap break-all text-xs"
          >
            {source?.referencePaths.join("\n")}
          </pre>
          <details>
            <summary className="cursor-pointer text-sm">
              {copy.policyRawCurrent}
            </summary>
            <pre
              data-testid="tag-maintenance-policy"
              dir="ltr"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs"
            >
              {snapshot.policy?.policy}
            </pre>
          </details>
        </section>
        {mode === "retire" && (
          <section className="grid gap-3" data-testid="tag-retirement-check">
            <label
              htmlFor="tag-retirement-external"
              className="flex items-start gap-2 text-sm"
            >
              <Checkbox
                id="tag-retirement-external"
                data-testid="tag-retirement-external"
                disabled={!known}
                checked={external}
                onCheckedChange={(value) => setExternal(value === true)}
              />
              {copy.policyExternalConfirm}
            </label>
            <Notice tone={retirementClear && external ? "info" : "warning"}>
              <p data-testid="tag-retirement-result">
                {retirementClear && external
                  ? copy.policyRetirementObserved
                  : copy.policyRetirementBlocked}
              </p>
              {(!retirementClear || !external) && (
                <ul className="mt-2 grid gap-1 text-xs">
                  {!known && (
                    <li data-testid="tag-retirement-blocker-unknown">
                      {copy.policyInventoryUnknownTitle}:{" "}
                      {inventory.unknownSources.join(", ")}
                    </li>
                  )}
                  {source?.definition === "declared" && (
                    <li data-testid="tag-retirement-blocker-definition">
                      {copy.policyRetirementDefinition}{" "}
                      <bdi dir="ltr">tagOwners · {tag}</bdi>
                    </li>
                  )}
                  {!!source?.nodeIds.length && (
                    <li data-testid="tag-retirement-blocker-nodes">
                      {copy.policyObservedNodes}:{" "}
                      <bdi dir="ltr">{source.nodeIds.join(", ")}</bdi>
                    </li>
                  )}
                  {!!source?.referencePaths.length && (
                    <li data-testid="tag-retirement-blocker-references">
                      {copy.policyObservedReferences}:{" "}
                      <bdi dir="ltr">{source.referencePaths.join(", ")}</bdi>
                    </li>
                  )}
                  {source?.keys.some(
                    (entry) =>
                      entry.registration === "available" ||
                      entry.registration === "unknown",
                  ) && (
                    <li data-testid="tag-retirement-blocker-keys">
                      {copy.policyObservedKeys}:{" "}
                      <bdi dir="ltr">
                        {source.keys
                          .filter(
                            (entry) =>
                              entry.registration === "available" ||
                              entry.registration === "unknown",
                          )
                          .map((entry) => entry.id)
                          .join(", ")}
                      </bdi>
                    </li>
                  )}
                  {!external && (
                    <li data-testid="tag-retirement-blocker-external">
                      {copy.policyRetirementExternalMissing}
                    </li>
                  )}
                </ul>
              )}
            </Notice>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
