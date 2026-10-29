import { useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/app/dialog";
import { useAppForm } from "@/components/app/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useHeadscaleI18n } from "@/i18n";
import { cn } from "@/lib/utils";
export interface AssignMemberOption {
  id: string;
  name: string;
  assigned: boolean;
  hint?: string;
}
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  options: readonly AssignMemberOption[];
  applyLabel: string;
  cancelLabel: string;
  emptyLabel: string;
  testidPrefix: string;
  assignedLabel: string;
  isSubmitting?: boolean;
  error?: string;
  notice?: string;
  onApply: (selection: string[]) => void | Promise<void>;
  onSelectionChange?: () => void;
}
export default function AssignMemberDialog({
  open,
  onOpenChange,
  title,
  description,
  options,
  applyLabel,
  cancelLabel,
  emptyLabel,
  testidPrefix,
  assignedLabel,
  isSubmitting = false,
  error = "",
  notice = "",
  onApply,
  onSelectionChange,
}: Props) {
  const { locale } = useHeadscaleI18n();
  const collator = new Intl.Collator(locale);
  const [defaultValues] = useState(() => ({
    selected: options
      .filter((option) => option.assigned)
      .map((option) => option.id),
  }));
  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      if (isSubmitting || !dirty) return;
      await onApply(value.selected);
    },
  });
  const selected = new Set(
    useStore(form.store, (state) => state.values.selected),
  );
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const busy = isSubmitting || submitting;
  // 仅重新打开时采用服务端选中项，刷新不能覆盖未提交的选择。
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      form.reset(
        {
          selected: options
            .filter((option) => option.assigned)
            .map((option) => option.id),
        },
        { keepDefaultValues: true },
      );
    }
    wasOpen.current = open;
  }, [form, open, options]);
  const sortedOptions = [...options].sort((a, b) =>
    collator.compare(a.name, b.name),
  );
  const dirty =
    selected.size !== options.filter((option) => option.assigned).length ||
    options.some((option) => option.assigned !== selected.has(option.id));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={`${testidPrefix}-dialog`}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form.AppForm>
          <form.Form
            className="grid gap-3"
            data-testid={`${testidPrefix}-form`}
          >
            {sortedOptions.length === 0 ? (
              <div
                className="rounded-md border bg-background px-3 py-6 text-center text-sm text-muted-foreground"
                data-testid={`${testidPrefix}-empty`}
              >
                {emptyLabel}
              </div>
            ) : (
              <form.Field name="selected">
                {(field) => (
                  <div className="grid max-h-[50vh] gap-1 overflow-y-auto pe-1">
                    {sortedOptions.map((option) => (
                      // 整行包含富文本和装饰性复选框，原生 input 无法容纳这些内容。
                      <button
                        key={option.id}
                        type="button"
                        role="checkbox"
                        aria-checked={selected.has(option.id)}
                        className={cn(
                          "flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          { "opacity-60": busy },
                        )}
                        disabled={busy}
                        data-testid={`${testidPrefix}-option-${option.id}`}
                        onBlur={field.handleBlur}
                        onClick={() => {
                          if (isSubmitting || form.state.isSubmitting) return;
                          onSelectionChange?.();
                          field.handleChange((current) =>
                            current.includes(option.id)
                              ? current.filter((id) => id !== option.id)
                              : [...current, option.id],
                          );
                        }}
                      >
                        <Checkbox
                          className="mt-0.5 pointer-events-none"
                          disabled={busy}
                          tabIndex={-1}
                          aria-hidden="true"
                          checked={selected.has(option.id)}
                        />
                        <div className="grid gap-1 text-sm">
                          <span className="font-medium break-all">
                            {option.name}
                          </span>
                          {option.hint && (
                            <span className="text-xs text-muted-foreground break-all">
                              {option.hint}
                            </span>
                          )}
                        </div>
                        {option.assigned && (
                          <Badge
                            variant="secondary"
                            className="ms-auto self-start text-xs font-normal"
                            data-testid={`${testidPrefix}-assigned-${option.id}`}
                          >
                            {assignedLabel}
                          </Badge>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </form.Field>
            )}
            {error && (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid={`${testidPrefix}-error`}
              >
                {error}
              </p>
            )}
            <DialogFooter>
              {notice && (
                <p className="text-sm text-muted-foreground">{notice}</p>
              )}
              <Button
                type="button"
                variant="outline"
                data-testid={`${testidPrefix}-cancel`}
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel}
              </Button>
              <form.SubmitButton
                data-testid={`${testidPrefix}-apply`}
                busy={isSubmitting}
                disabled={!dirty}
              >
                {applyLabel}
              </form.SubmitButton>
            </DialogFooter>
          </form.Form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
