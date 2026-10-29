import { useStore } from "@tanstack/react-form";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { submitForm, useAppForm } from "@/components/app/form";
import { Button } from "@/components/ui/button";
import { useProductCopy } from "@/composables/useProductCopy";
import { joinCommaList, parseCommaList } from "@/domain/policy-designer";
import { destinationHasPort, type IpRule } from "@/domain/policy-views";

const blank = (value: string) => parseCommaList(value).length === 0;

export function RuleRestrictions({
  extras,
  expanded = false,
}: {
  extras?: Record<string, unknown>;
  expanded?: boolean;
}) {
  const { copy } = useProductCopy();
  if (!extras || Object.keys(extras).length === 0) return null;
  return (
    // Native summary handles Enter/Space; only stop the parent card from opening.
    <details
      open={expanded}
      className="min-w-0 text-xs"
      onClick={(event) => event.stopPropagation()}
    >
      <summary className="cursor-pointer break-all">
        <span>{copy.policyRuleRestrictions}</span>
        {(typeof extras.proto === "string" ||
          typeof extras.proto === "number") && (
          <>
            {" "}
            · <bdi dir="ltr">{extras.proto}</bdi>
          </>
        )}
      </summary>
      <pre
        dir="ltr"
        className="mt-1 whitespace-pre-wrap break-all rounded bg-muted p-2 text-start"
      >
        {JSON.stringify(extras, null, 2)}
      </pre>
    </details>
  );
}

interface Props {
  rule: IpRule;
  onDirtyChange: (dirty: boolean) => void;
  isEditing: boolean;
  // A rule that is not in the policy yet is only ever shown in edit mode.
  onEditStart?: () => void;
  onEditCancel: () => void;
  onUpdate: (patch: {
    source: string;
    destination: string;
    ports: string;
  }) => void;
  onRemove?: () => void;
}

export default function IpRuleRow({
  rule,
  isEditing,
  onEditStart,
  onEditCancel,
  onUpdate,
  onRemove,
  onDirtyChange,
}: Props) {
  const { copy } = useProductCopy();
  const form = useAppForm({
    defaultValues: {
      source: rule.source,
      destination: rule.destination,
      ports: rule.ports,
    },
    onSubmit: ({ value }) => {
      const patch = {
        source: value.source.trim(),
        destination: value.destination.trim(),
        ports: joinCommaList(parseCommaList(value.ports)),
      };
      if (
        patch.source === rule.source &&
        patch.destination === rule.destination &&
        patch.ports === rule.ports
      ) {
        onEditCancel();
        return;
      }
      onUpdate(patch);
    },
  });
  const draft = useStore(form.store, (state) => state.values);
  const dirty =
    draft.source !== rule.source ||
    draft.destination !== rule.destination ||
    draft.ports !== rule.ports;
  useEffect(() => {
    if (isEditing) onDirtyChange(dirty);
  }, [isEditing, dirty, onDirtyChange]);
  // 仅进入编辑模式时重置，刷新不能覆盖局部草稿。
  useEffect(() => {
    if (isEditing)
      form.reset({
        source: rule.source,
        destination: rule.destination,
        ports: rule.ports,
      });
  }, [form, isEditing]);
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
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitForm(form);
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
        <div className="min-w-0">
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
          <RuleRestrictions extras={rule.extras} />
        </div>
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
    <form.AppForm>
      <form.Form
        className="grid gap-2 rounded-md border bg-muted/30 px-3 py-2"
        data-testid={`ip-rule-edit-form-${rule.ruleId}`}
      >
        <div className="grid items-start gap-2 sm:grid-cols-[1fr_auto_1fr_auto_minmax(6rem,1fr)]">
          <form.AppField
            name="source"
            validators={{
              onDynamic: ({ value }) =>
                blank(value) ? copy.ipRuleFieldsRequired : undefined,
            }}
          >
            {(field) => (
              <field.TextField
                id={`ip-rule-source-${rule.ruleId}`}
                ref={firstField}
                label={copy.ipRuleSourcePlaceholder}
                className="font-mono text-xs"
                dir="ltr"
                placeholder="10.0.0.0/8, group:ops"
                data-testid={`ip-rule-source-${rule.ruleId}`}
                onKeyDown={keyDown}
              />
            )}
          </form.AppField>
          <span className="text-muted-foreground text-sm text-center hidden sm:block">
            &rarr;
          </span>
          <form.AppField
            name="destination"
            validators={{
              onDynamic: ({ value }) =>
                blank(value)
                  ? copy.ipRuleFieldsRequired
                  : destinationHasPort(value)
                    ? copy.ipRuleDestinationHasPort
                    : undefined,
            }}
          >
            {(field) => (
              <field.TextField
                id={`ip-rule-destination-${rule.ruleId}`}
                label={copy.ipRuleDestinationPlaceholder}
                className="font-mono text-xs"
                dir="ltr"
                placeholder="192.168.0.0/16, tag:server"
                data-testid={`ip-rule-destination-${rule.ruleId}`}
                onKeyDown={keyDown}
              />
            )}
          </form.AppField>
          <span className="text-muted-foreground text-sm text-center hidden sm:block">
            &middot;
          </span>
          <form.AppField
            name="ports"
            validators={{
              onDynamic: ({ value }) =>
                blank(value) ? copy.ipRuleFieldsRequired : undefined,
            }}
          >
            {(field) => (
              <field.TextField
                id={`ip-rule-ports-${rule.ruleId}`}
                label={copy.ipRulePortsPlaceholder}
                className="font-mono text-xs"
                dir="ltr"
                placeholder="22,80,443"
                data-testid={`ip-rule-ports-${rule.ruleId}`}
                onKeyDown={keyDown}
              />
            )}
          </form.AppField>
        </div>
        <RuleRestrictions extras={rule.extras} />
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={copy.cancelIpRuleEdit}
            data-testid={`ip-rule-cancel-${rule.ruleId}`}
            onClick={onEditCancel}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          <form.SubmitButton
            size="sm"
            aria-label={copy.saveIpRule}
            data-testid={`ip-rule-save-${rule.ruleId}`}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
          </form.SubmitButton>
        </div>
      </form.Form>
    </form.AppForm>
  );
}
