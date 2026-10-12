import { CalendarClock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  ar,
  type DayPickerLocale,
  enUS,
  es,
  fr,
  it,
  ja,
  ko,
  ru,
  zhCN,
  zhHK,
  zhTW,
} from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TimePicker } from "@/components/ui/time-picker";
import { LOCALE_META, type Locale, resolveLocale } from "@/i18n/locales";
import { cn } from "@/lib/utils";
import { DATE_TIME_FORMAT } from "@/utils/format";

export interface DateTimePickerProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  locale?: string;
  placeholder: string;
  timeLabel: string;
  hourLabel: string;
  minuteLabel: string;
  error?: string;
  testId?: string;
  className?: string;
}

const dayPickerLocales = {
  ar,
  "en-US": enUS,
  "es-ES": es,
  "fr-FR": fr,
  "it-IT": it,
  "ja-JP": ja,
  "ko-KR": ko,
  "ru-RU": ru,
  "zh-Hans": zhCN,
  "zh-Hant-HK": zhHK,
  "zh-Hant-TW": zhTW,
} satisfies Record<Locale, DayPickerLocale>;
const pad = (value: number) => String(value).padStart(2, "0");
function parseLocalDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  const date = match
    ? new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
      )
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function DateTimePicker({
  id,
  value,
  onValueChange,
  locale = "en-US",
  placeholder,
  timeLabel,
  hourLabel,
  minuteLabel,
  error,
  testId,
  className,
}: DateTimePickerProps) {
  const selectedDate = parseLocalDateTime(value);
  const [month, setMonth] = useState(selectedDate ?? new Date());
  const [emptyTime, setEmptyTime] = useState("00:00");
  const time = selectedDate
    ? `${pad(selectedDate.getHours())}:${pad(selectedDate.getMinutes())}`
    : emptyTime;
  useEffect(() => {
    const date = parseLocalDateTime(value);
    setMonth(date ?? new Date());
    if (!date) setEmptyTime("00:00");
  }, [value]);
  const generated = useId();
  const prefix = id ?? testId ?? generated;
  const triggerId = id ?? `${prefix}-trigger`;
  const valueId = `${prefix}-value`;
  const labelId = `${prefix}-time-label`;
  const errorId = `${prefix}-error`;
  const resolved = resolveLocale(locale);
  function emit(date: Date | undefined, nextTime: string) {
    onValueChange(
      date
        ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${nextTime}`
        : "",
    );
  }
  return (
    <div className={cn("grid gap-2", className)} data-slot="date-time-picker">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              id={triggerId}
              type="button"
              variant="outline"
              data-testid={testId}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${valueId} ${errorId}` : valueId}
              className="w-full justify-start text-start font-normal"
            />
          }
        >
          <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span id={valueId} className="min-w-0 truncate">
            {selectedDate
              ? new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT).format(selectedDate)
              : placeholder}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="max-h-[var(--available-height)] w-auto overflow-auto p-0"
          align="start"
          aria-labelledby={triggerId}
        >
          <div className="grid">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => {
                if (date) emit(date, time);
              }}
              month={month}
              onMonthChange={setMonth}
              captionLayout="dropdown"
              startMonth={new Date(month.getFullYear() - 100, 0)}
              endMonth={new Date(month.getFullYear() + 10, 11)}
              locale={dayPickerLocales[resolved]}
              dir={LOCALE_META[resolved].dir}
            />
            <div className="sticky bottom-0 z-10 border-t bg-popover p-3">
              <p
                id={labelId}
                className="mb-2 text-sm font-medium"
                data-testid={testId ? `${testId}-time-label` : undefined}
              >
                {timeLabel}
              </p>
              <TimePicker
                value={time}
                onValueChange={(next) => {
                  setEmptyTime(next);
                  emit(selectedDate, next);
                }}
                locale={locale}
                hourLabel={hourLabel}
                minuteLabel={minuteLabel}
                testIdPrefix={testId}
                aria-labelledby={labelId}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {error && (
        <p
          id={errorId}
          role="alert"
          data-testid={testId ? `${testId}-error` : undefined}
          className="text-sm text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
