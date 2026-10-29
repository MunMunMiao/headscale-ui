import type { ComponentProps } from "react";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/app/native-select";
import { cn } from "@/lib/utils";

export interface TimePickerProps extends Omit<
  ComponentProps<"div">,
  "onChange"
> {
  value?: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  locale?: string;
  hourLabel?: string;
  minuteLabel?: string;
  testIdPrefix?: string;
}

export function TimePicker({
  value = "00:00",
  onValueChange,
  disabled = false,
  locale = "en-US",
  hourLabel = "Hour",
  minuteLabel = "Minute",
  testIdPrefix,
  className,
  ...props
}: TimePickerProps) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  const valid = match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
  const hour = valid ? match[1].padStart(2, "0") : "00";
  const minute = valid ? match[2] : "00";
  const formatter = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
    useGrouping: false,
  });
  const options = (length: number) =>
    Array.from({ length }, (_, number) => number).map((number) => (
      <NativeSelectOption key={number} value={String(number).padStart(2, "0")}>
        {formatter.format(number)}
      </NativeSelectOption>
    ));
  return (
    // a fieldset would change the grid layout and the div-typed props.
    <div
      role="group"
      {...props}
      className={cn("grid grid-cols-2 gap-2", className)}
      data-slot="time-picker"
    >
      <NativeSelect
        value={hour}
        disabled={disabled}
        aria-label={hourLabel}
        data-testid={testIdPrefix ? `${testIdPrefix}-hour` : undefined}
        onChange={(event) => onValueChange(`${event.target.value}:${minute}`)}
      >
        {options(24)}
      </NativeSelect>
      <NativeSelect
        value={minute}
        disabled={disabled}
        aria-label={minuteLabel}
        data-testid={testIdPrefix ? `${testIdPrefix}-minute` : undefined}
        onChange={(event) => onValueChange(`${hour}:${event.target.value}`)}
      >
        {options(60)}
      </NativeSelect>
    </div>
  );
}
