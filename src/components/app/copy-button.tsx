import { ClipboardCheck, Copy } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useHeadscaleI18n } from "@/i18n";

type Props = Omit<ComponentProps<typeof Button>, "value" | "onClick"> & {
  value: string;
  iconClassName?: string;
};

export function CopyButton({
  value,
  children,
  iconClassName = "h-4 w-4",
  ...buttonProps
}: Props) {
  const { t } = useHeadscaleI18n();
  const [state, setState] = useState<{ value: string; ok: boolean } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    let ok = true;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      ok = false;
    }
    setState({ value, ok });
    timer.current = setTimeout(() => setState(null), ok ? 1200 : 5000);
  }

  const shown = state?.value === value ? state : null;
  const status = shown ? t(shown.ok ? "copied" : "copyFailed") : "";
  return (
    <Button {...buttonProps} type="button" onClick={copy}>
      {shown?.ok ? (
        <ClipboardCheck className={iconClassName} aria-hidden="true" />
      ) : (
        <Copy className={iconClassName} aria-hidden="true" />
      )}
      {shown ? status : children}
    </Button>
  );
}
