import { Check, Pencil, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProductCopy } from "@/composables/useProductCopy";
import { joinCommaList, parseCommaList } from "@/domain/policy-designer";
import { destinationHasPort, type IpRule } from "@/domain/policy-views";

const blank = (value: string) => parseCommaList(value).length === 0;

interface Props {
  rule: IpRule;
  isEditing: boolean;
  // A rule that is not in the policy yet is only ever shown in edit mode.
  onEditStart?: () => void;
  onEditCancel: () => void;
  onUpdate: (patch: { source: string; destination: string; ports: string }) => void;
  onRemove?: () => void;
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
  // Focus follows the mode switch: into the first field, then back to this row's edit button unless
  // another row has already taken focus.
  const firstField = useRef<HTMLInputElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(isEditing);
  useEffect(() => {
    if (isEditing) firstField.current?.focus();
    else if (wasEditing.current && document.activeElement === document.body)
      editButton.current?.focus();
    wasEditing.current = isEditing;
  }, [isEditing]);
  function commit() {
    const source = sourceDraft.trim();
    const destination = destinationDraft.trim();
    const ports = joinCommaList(parseCommaList(portsDraft));
    if (blank(source) || blank(destination) || !ports || destinationHasPort(destination)) {
      setSubmitted(true);
      return;
    }
    if (source === rule.source && destination === rule.destination && ports === rule.ports) {
      onEditCancel();
      return;
    }
    onUpdate({ source, destination, ports });
  }
  const missing = submitted && [sourceDraft, destinationDraft, portsDraft].some(blank);
  const portInDestination = submitted && destinationHasPort(destinationDraft);
  const fieldProps = (invalid: boolean) =>
    invalid ? { "aria-invalid": true, "aria-describedby": errorId } : {};
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
            ref={editButton}
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
          ref={firstField}
          value={sourceDraft}
          onChange={(event) => setSourceDraft(event.target.value)}
          className="font-mono text-xs"
          dir="ltr"
          {...fieldProps(submitted && blank(sourceDraft))}
          aria-label={copy.ipRuleSourcePlaceholder}
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
          {...fieldProps((submitted && blank(destinationDraft)) || portInDestination)}
          aria-label={copy.ipRuleDestinationPlaceholder}
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
          {...fieldProps(submitted && blank(portsDraft))}
          aria-label={copy.ipRulePortsPlaceholder}
          placeholder={copy.ipRulePortsPlaceholder}
          data-testid={`ip-rule-ports-${rule.ruleId}`}
          onKeyDown={keyDown}
        />
      </div>
      {(missing || portInDestination) && (
        <p id={errorId} role="alert" data-testid={errorId} className="text-xs text-destructive">
          {missing ? copy.ipRuleFieldsRequired : copy.ipRuleDestinationHasPort}
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
