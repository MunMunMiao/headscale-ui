import { useRef } from "react";
import { Notice } from "@/components/app/notice";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useProductCopy } from "@/composables/useProductCopy";

/** Access publishes one complete document, never a patch scoped to the open tag. */
export default function AccessPolicyReview({
  original,
  submitted,
  latest,
  issues = [],
  error,
  disabled,
  onConfirm,
  onCancel,
}: {
  original: string;
  submitted: string;
  latest?: string;
  issues?: string[];
  error?: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { copy } = useProductCopy();
  const heading = useRef<HTMLHeadingElement>(null);
  const conflict = latest !== undefined && latest !== original;
  return (
    <AlertDialog open onOpenChange={onCancel}>
      <AlertDialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-4xl"
        data-testid="policy-publication-review"
        initialFocus={heading}
      >
        <AlertDialogHeader>
          <AlertDialogTitle
            ref={heading}
            tabIndex={-1}
            className="outline-none"
          >
            {copy.policyPublishReview}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {copy.policyPublishScope}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          {copy.policyNormalizationNotice}
        </p>
        {issues.length > 0 && (
          <section
            data-testid="policy-publication-unmodeled"
            className="text-sm text-amber-700 dark:text-amber-300"
          >
            <p>{copy.policyUnmodeledReview}</p>
            <pre
              dir="ltr"
              className="overflow-auto whitespace-pre-wrap break-all text-xs"
            >
              {issues.join("\n")}
            </pre>
          </section>
        )}
        <section
          aria-label={copy.policyRawDiff}
          className="grid min-w-0 gap-3 sm:grid-cols-2"
        >
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{copy.policyRawOriginal}</h3>
            <pre
              dir="ltr"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="policy-publication-original"
              tabIndex={0}
              role="region"
              aria-label={copy.policyRawOriginal}
            >
              {original}
            </pre>
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{copy.policyFullSubmitted}</h3>
            <pre
              dir="ltr"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="policy-publication-submitted"
              tabIndex={0}
              role="region"
              aria-label={copy.policyFullSubmitted}
            >
              {submitted}
            </pre>
          </div>
        </section>
        {conflict && (
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{copy.policyRawCurrent}</h3>
            <pre
              dir="ltr"
              className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="policy-publication-current"
              tabIndex={0}
              role="region"
              aria-label={copy.policyRawCurrent}
            >
              {latest}
            </pre>
          </div>
        )}
        <Notice tone="info" className="text-xs">
          <p>{copy.policyPublishCheckScope}</p>
          <p className="mt-1">{copy.policyPublishRace}</p>
        </Notice>
        {error && (
          <Notice
            tone="error"
            title={conflict ? copy.policySaveConflictTitle : undefined}
          >
            {error}
          </Notice>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="policy-publication-cancel"
            disabled={disabled}
            onClick={onCancel}
          >
            {copy.cancel}
          </AlertDialogCancel>
          <Button
            data-testid="policy-publication-confirm"
            disabled={disabled || conflict}
            onClick={onConfirm}
          >
            {copy.policyPublishAll}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
