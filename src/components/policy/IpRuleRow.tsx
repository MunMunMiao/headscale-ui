import { Check, Pencil, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProductCopy } from "@/composables/useProductCopy";
import type { IpRule } from "@/domain/policy-views";

interface Props {
  rule: IpRule;
  isEditing: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onUpdate: (patch: { source: string; destination: string; ports: string }) => void;
  onRemove: () => void;
}

export default function IpRuleRow({
  rule,
  isEditing,
  onEditStart,
  onEditCancel,
  onUpdate,
  onRemove,
}: Props) {
  const { copy } = useProductCopy();
  const [sourceDraft, setSourceDraft] = useState(rule.source);
  const [destinationDraft, setDestinationDraft] = useState(rule.destination);
  const [portsDraft, setPortsDraft] = useState(rule.ports);
  const [submitted, setSubmitted] = useState(false);
  const errorId = `ip-rule-error-${rule.ruleId}`;
  useEffect(() => {
    if (isEditing) {
      setSubmitted(false);
      setSourceDraft(rule.source);
      setDestinationDraft(rule.destination);
      setPortsDraft(rule.ports);
    }
  }, [isEditing, rule.source, rule.destination, rule.ports]);
  function commit() {
    const source = sourceDraft.trim();
    const destination = destinationDraft.trim();
    const ports = portsDraft.trim();
    if (source === rule.source && destination === rule.destination && ports === rule.ports) {
      onEditCancel();
      return;
    }
    if (!source || !destination || !ports) {
      setSubmitted(true);
      return;
    }
    onUpdate({ source, destination, ports });
  }
  const invalid = (value: string) => submitted && !value.trim();
  const fieldProps = (value: string) =>
    invalid(value) ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onEditCancel();
    }
  }
  if (!isEditing)
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
        data-testid={`ip-rule-${rule.ruleId}`}
      >
        <p className="break-all min-w-0">
          <span className="font-medium">
            <bdi dir="ltr">{rule.source}</bdi>
          </span>
          <span className="text-muted-foreground"> &rarr; </span>
          <span className="break-all">
            <bdi dir="ltr">{rule.destination}</bdi>
          </span>
          <span className="text-muted-foreground">
            {" "}
            &middot; <bdi dir="ltr">{rule.ports}</bdi>
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${copy.editIpRule} ${rule.source} -> ${rule.destination}`}
            data-testid={`ip-rule-edit-${rule.ruleId}`}
            onClick={onEditStart}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${copy.removeRule} ${rule.source} -> ${rule.destination}`}
            data-testid={`ip-rule-remove-${rule.ruleId}`}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  return (
    <div
      className="grid gap-2 rounded-md border bg-muted/30 px-3 py-2"
      data-testid={`ip-rule-edit-form-${rule.ruleId}`}
    >
      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_minmax(6rem,1fr)]">
        <Input
          value={sourceDraft}
          onChange={(event) => setSourceDraft(event.target.value)}
          className="font-mono text-xs"
          dir="ltr"
          {...fieldProps(sourceDraft)}
          placeholder={copy.ipRuleSourcePlaceholder}
          data-testid={`ip-rule-source-${rule.ruleId}`}
          onKeyDown={keyDown}
        />
        <span className="text-muted-foreground text-sm text-center hidden sm:block">&rarr;</span>
        <Input
          value={destinationDraft}
          onChange={(event) => setDestinationDraft(event.target.value)}
          className="font-mono text-xs"
          dir="ltr"
          {...fieldProps(destinationDraft)}
          placeholder={copy.ipRuleDestinationPlaceholder}
          data-testid={`ip-rule-destination-${rule.ruleId}`}
          onKeyDown={keyDown}
        />
        <span className="text-muted-foreground text-sm text-center hidden sm:block">&middot;</span>
        <Input
          value={portsDraft}
          onChange={(event) => setPortsDraft(event.target.value)}
          className="font-mono text-xs"
          dir="ltr"
          {...fieldProps(portsDraft)}
          placeholder={copy.ipRulePortsPlaceholder}
          data-testid={`ip-rule-ports-${rule.ruleId}`}
          onKeyDown={keyDown}
        />
      </div>
      {(invalid(sourceDraft) || invalid(destinationDraft) || invalid(portsDraft)) && (
        <p id={errorId} role="alert" data-testid={errorId} className="text-xs text-destructive">
          {copy.ipRuleFieldsRequired}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={copy.cancelIpRuleEdit}
          data-testid={`ip-rule-cancel-${rule.ruleId}`}
          onClick={onEditCancel}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          aria-label={copy.saveIpRule}
          data-testid={`ip-rule-save-${rule.ruleId}`}
          onClick={commit}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
