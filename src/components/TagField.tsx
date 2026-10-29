import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Notice } from "@/components/app/notice";
import { Tooltip } from "@/components/app/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProductCopy } from "@/composables/useProductCopy";
import { isPolicyIdentityName } from "@/domain/policy-designer";
import { isNodeTag } from "@/utils/node";

export interface TagFieldProps {
  id: string;
  mode: "device" | "key";
  value: readonly string[];
  onChange: (tags: string[]) => void;
  options: readonly string[];
  declaredTags: readonly string[] | null;
  search?: string;
  onSearchChange?: (search: string) => void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onManage?: (tag?: string) => void;
  onBlur?: () => void;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** A selected list and optional search, not a second form or a policy editor. */
export function TagField({
  id,
  mode,
  value,
  onChange,
  options,
  declaredTags,
  search,
  onSearchChange,
  disabled = false,
  loading = false,
  error,
  onRetry,
  onManage,
  onBlur,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: TagFieldProps) {
  const { copy } = useProductCopy();
  const [localSearch, setLocalSearch] = useState("");
  const query = search ?? localSearch;
  const updateSearch = (next: string) => {
    setLocalSearch(next);
    onSearchChange?.(next);
  };
  const compatible = [...new Set(options)].filter(
    (tag) => isNodeTag(tag) && (mode === "key" || declaredTags?.includes(tag)),
  );
  const available = compatible.filter((tag) => !value.includes(tag));
  const matches = available.filter((tag) =>
    tag.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const canAdd =
    mode === "key" && isNodeTag(query.trim()) && !value.includes(query.trim());
  const locked = disabled || loading;
  const add = (tag: string) => onChange([...value, tag]);
  return (
    <div
      className="grid min-w-0 gap-3"
      data-testid={id}
      aria-busy={loading || undefined}
    >
      <fieldset className="grid min-w-0 gap-2" data-testid={`${id}-selected`}>
        <legend className="mb-2 text-sm font-medium">
          {copy.tagSelection} ({value.length})
        </legend>
        {[...new Set(value)].map((tag) => (
          <div
            key={tag}
            className="flex min-w-0 flex-wrap items-start gap-2 rounded-md border p-2"
          >
            <div className="grid min-w-0 flex-1 gap-1 text-sm">
              <bdi dir="ltr" className="break-all font-mono">
                {tag}
              </bdi>
              <span className="text-xs text-muted-foreground">
                {declaredTags === null
                  ? copy.tagDefinitionUnknown
                  : declaredTags.includes(tag)
                    ? copy.tagDeclared
                    : copy.tagUndeclared}
              </span>
              {!isNodeTag(tag) || !isPolicyIdentityName(tag, "tag") ? (
                <span className="text-xs text-muted-foreground">
                  {copy.tagReplaceIncompatible}
                </span>
              ) : declaredTags !== null &&
                !declaredTags.includes(tag) &&
                onManage ? (
                <button
                  type="button"
                  className="w-fit text-start text-xs text-primary underline"
                  disabled={locked}
                  data-testid={`${id}-define-${tag}`}
                  onClick={() => onManage(tag)}
                >
                  {copy.tagDefine}
                </button>
              ) : null}
            </div>
            <Tooltip content={`${copy.remove} ${tag}`}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={locked}
                aria-label={`${copy.remove} ${tag}`}
                data-testid={`${id}-remove-${tag}`}
                onClick={() => onChange(value.filter((item) => item !== tag))}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        ))}
      </fieldset>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor={`${id}-search`}>{copy.tagSearch}</Label>
        <Input
          id={`${id}-search`}
          data-testid={`${id}-search`}
          value={query}
          disabled={locked}
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          onBlur={onBlur}
          aria-invalid={invalid || Boolean(error)}
          aria-describedby={[describedBy, error && `${id}-error`, `${id}-hint`]
            .filter(Boolean)
            .join(" ")}
          onChange={(event) => updateSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit"
            disabled={locked}
            data-testid={`${id}-clear`}
            onClick={() => updateSearch("")}
          >
            {copy.clearFilters}
          </Button>
        )}
        <div
          className="grid max-h-40 min-w-0 gap-1 overflow-y-auto"
          data-testid={`${id}-options`}
        >
          {matches.map((tag) => (
            <Button
              key={tag}
              type="button"
              variant="outline"
              className="h-auto justify-start whitespace-normal text-start"
              disabled={locked}
              data-testid={`${id}-option-${tag}`}
              onClick={() => add(tag)}
            >
              <Plus className="size-4" aria-hidden="true" />
              <bdi dir="ltr" className="break-all">
                {tag}
              </bdi>
            </Button>
          ))}
        </div>
        {!matches.length && (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`${id}-empty`}
          >
            {query.trim()
              ? copy.tagNoMatches
              : compatible.length > 0
                ? copy.tagAllSelected
                : mode === "key"
                  ? copy.tagNoSuggestions
                  : copy.tagNoOptions}
          </p>
        )}
        {mode === "key" && query.trim() && (
          <Button
            type="button"
            variant="outline"
            className="w-fit"
            disabled={locked || !canAdd}
            data-testid={`${id}-add`}
            onClick={() => {
              add(query.trim());
              updateSearch("");
            }}
          >
            {copy.tagAdd}
          </Button>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {mode === "key" ? copy.tagKeyUndeclaredHint : copy.tagReadbackHint}
      </p>
      {error && (
        <div data-testid={`${id}-error`}>
          <Notice id={`${id}-error`} tone="error" className="text-xs">
            {error}
          </Notice>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            data-testid={`${id}-retry`}
            onClick={onRetry}
          >
            {copy.tagRetry}
          </Button>
        )}
        {onManage && (
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={locked}
            data-testid={`${id}-manage`}
            onClick={() => onManage()}
          >
            {copy.manageTags}
          </Button>
        )}
      </div>
    </div>
  );
}
