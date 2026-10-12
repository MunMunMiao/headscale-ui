import { Plus, Search } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

export interface MemberOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  groupOrder?: number;
}

interface Props<T extends MemberOption> {
  onPick: (value: string) => void;
  options: readonly T[];
  triggerLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  testid: string;
  disabled?: boolean;
}

export default function MemberPicker<T extends MemberOption>({
  onPick,
  options,
  triggerLabel,
  searchPlaceholder,
  emptyText,
  testid,
  disabled = false,
}: Props<T>) {
  const [open, updateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  function setOpen(value: boolean) {
    updateOpen(value);
    if (!value) setSearch("");
  }
  const query = search.trim().toLowerCase();
  const filteredOptions = options.filter(
    (option) =>
      !query ||
      [option.label, option.value, option.description ?? ""].some((text) =>
        text.toLowerCase().includes(query),
      ),
  );
  const buckets = new Map<string, { label: string; order: number; items: T[] }>();
  for (const option of filteredOptions) {
    const key = option.group ?? "";
    const existing = buckets.get(key);
    if (existing) existing.items.push(option);
    else buckets.set(key, { label: key, order: option.groupOrder ?? 999, items: [option] });
  }
  const groupedOptions = Array.from(buckets.values()).sort((a, b) => a.order - b.order);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            data-testid={`${testid}-trigger`}
            className="gap-1.5"
          />
        }
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        <span>{triggerLabel}</span>
      </PopoverTrigger>
      <PopoverContent
        className="w-[20rem] max-w-[var(--available-width)] p-0"
        align="start"
        initialFocus={input}
        data-testid={`${testid}-content`}
      >
        <PopoverTitle className="sr-only">{triggerLabel}</PopoverTitle>
        <div className="grid max-h-[var(--available-height)] grid-rows-[auto_minmax(0,1fr)] gap-2 p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={input}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="ps-8"
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              disabled={disabled}
              data-testid={`${testid}-search`}
              autoComplete="off"
            />
          </div>
          <div
            className="grid min-h-0 max-h-[16rem] gap-1 overflow-y-auto pe-1"
            data-testid={`${testid}-list`}
          >
            {filteredOptions.length === 0 && (
              <p
                role="status"
                className="px-2 py-3 text-center text-sm text-muted-foreground"
                data-testid={`${testid}-empty`}
              >
                {emptyText}
              </p>
            )}
            {groupedOptions.map((bucket) => (
              <fieldset key={bucket.label} className="grid min-w-0 gap-1">
                {bucket.label && (
                  <legend className="mb-1 px-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {bucket.label}
                  </legend>
                )}
                {bucket.items.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={disabled}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    data-testid={`${testid}-option-${option.value}`}
                    onClick={() => {
                      onPick(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="grid gap-0.5 min-w-0 flex-1">
                      <span className="font-medium break-all">{option.label}</span>
                      {option.description && (
                        <span className="text-xs text-muted-foreground break-all">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </fieldset>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
