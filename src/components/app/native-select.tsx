import type { ComponentProps } from "react";
import { NativeSelect as PrimitiveSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export {
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";

export function NativeSelect({
  className,
  ...props
}: ComponentProps<typeof PrimitiveSelect>) {
  return (
    <PrimitiveSelect
      {...props}
      className={cn(
        "w-full [&_select[data-size=default]]:h-9 [&_select]:ps-2.5 [&_select]:pe-8 [&_select]:text-base md:[&_select]:text-sm [&_[data-slot=native-select-icon]]:rtl:left-2.5 [&_[data-slot=native-select-icon]]:rtl:right-auto",
        className,
      )}
    />
  );
}
