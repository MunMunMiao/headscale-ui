import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  onApply: (selection: string[]) => void;
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
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(options.filter((o) => o.assigned).map((o) => o.id)),
  );
  const assignedIds = options.filter((o) => o.assigned).map((o) => o.id);
  const assignmentSignature = JSON.stringify(assignedIds);
  useEffect(() => {
    if (open) setSelected(new Set(JSON.parse(assignmentSignature) as string[]));
  }, [open, assignmentSignature]);
  const sortedOptions = [...options].sort((a, b) => collator.compare(a.name, b.name));
  const dirty =
    selected.size !== options.filter((o) => o.assigned).length ||
    options.some((o) => o.assigned !== selected.has(o.id));
  // Rows are disabled while submitting, so a toggle cannot race the submission.
  function toggle(option: AssignMemberOption) {
    onSelectionChange?.();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(option.id)) next.delete(option.id);
      else next.add(option.id);
      return next;
    });
  }
  function submit() {
    onApply(Array.from(selected));
  }
  function closeDialog() {
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid={`${testidPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          data-testid={`${testidPrefix}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {sortedOptions.length === 0 ? (
            <div
              className="rounded-md border bg-background px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid={`${testidPrefix}-empty`}
            >
              {emptyLabel}
            </div>
          ) : (
            <div className="grid max-h-[50vh] gap-1 overflow-y-auto pe-1">
              {sortedOptions.map((option) => (
                // biome-ignore lint/a11y/useSemanticElements: the row holds rich content and a decorative Checkbox; a native input cannot wrap it
                <button
                  key={option.id}
                  type="button"
                  role="checkbox"
                  aria-checked={selected.has(option.id)}
                  className={cn(
                    "flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    { "opacity-60": isSubmitting },
                  )}
                  disabled={isSubmitting}
                  data-testid={`${testidPrefix}-option-${option.id}`}
                  onClick={() => toggle(option)}
                >
                  <Checkbox
                    className="mt-0.5 pointer-events-none"
                    disabled={isSubmitting}
                    tabIndex={-1}
                    aria-hidden="true"
                    checked={selected.has(option.id)}
                  />
                  <div className="grid gap-1 text-sm">
                    <span className="font-medium break-all">{option.name}</span>
                    {option.hint && (
                      <span className="text-xs text-muted-foreground break-all">{option.hint}</span>
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
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid={`${testidPrefix}-error`}
            >
              {error}
            </p>
          )}
          <DialogFooter>
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              data-testid={`${testidPrefix}-cancel`}
              disabled={isSubmitting}
              onClick={closeDialog}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              data-testid={`${testidPrefix}-apply`}
              disabled={isSubmitting || !dirty}
            >
              {isSubmitting && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {applyLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
