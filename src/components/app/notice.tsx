import {
  CheckIcon,
  CircleAlertIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { NotificationTone } from "@/composables/useActionFeedback";
import { cn } from "@/lib/utils";

export interface NoticeProps {
  tone: NotificationTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  id?: string;
  className?: string;
}

const tones = {
  info: {
    icon: InfoIcon,
    style:
      "border-border bg-muted/40 [&_[data-slot=notice-icon]]:text-muted-foreground",
  },
  success: {
    icon: CheckIcon,
    style:
      "border-emerald-600/25 bg-emerald-600/5 [&_[data-slot=notice-icon]]:text-emerald-700 dark:[&_[data-slot=notice-icon]]:text-emerald-400",
  },
  warning: {
    icon: TriangleAlertIcon,
    style:
      "border-amber-600/30 bg-amber-600/5 [&_[data-slot=notice-icon]]:text-amber-700 dark:[&_[data-slot=notice-icon]]:text-amber-400",
  },
  error: {
    icon: CircleAlertIcon,
    style:
      "border-destructive/30 bg-destructive/5 [&_[data-slot=notice-icon]]:text-destructive",
  },
};

export function Notice({
  tone,
  title,
  children,
  action,
  id,
  className,
}: NoticeProps) {
  const Icon = tones[tone].icon;
  return (
    <div
      id={id}
      data-slot="notice"
      data-tone={tone}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm text-foreground",
        tones[tone].style,
        className,
      )}
    >
      <Icon
        data-slot="notice-icon"
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-1 break-words">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
