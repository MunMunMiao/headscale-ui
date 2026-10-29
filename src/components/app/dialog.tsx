import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogContent as PrimitiveContent,
  DialogFooter as PrimitiveFooter,
} from "@/components/ui/dialog";
import { useHeadscaleI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export * from "@/components/ui/dialog";

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof PrimitiveContent>) {
  const { t } = useHeadscaleI18n();
  return (
    <PrimitiveContent
      {...props}
      showCloseButton={false}
      className={cn(
        "max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] overflow-x-hidden overflow-y-auto overscroll-contain [&_[data-slot=dialog-header]]:min-w-0",
        showCloseButton && "[&_[data-slot=dialog-header]]:pe-10",
        className,
      )}
    >
      {children}
      {showCloseButton && (
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 end-2"
            />
          }
        >
          <XIcon aria-hidden="true" />
          <span className="sr-only">{t("close")}</span>
        </DialogClose>
      )}
    </PrimitiveContent>
  );
}

export function DialogFooter({
  children,
  className,
  showCloseButton = false,
  ...props
}: ComponentProps<typeof PrimitiveFooter>) {
  const { t } = useHeadscaleI18n();
  return (
    <PrimitiveFooter
      {...props}
      className={cn("mx-0 mb-0 border-0 bg-transparent p-0", className)}
      showCloseButton={false}
    >
      {children}
      {showCloseButton && (
        <DialogClose render={<Button variant="outline" />}>
          {t("close")}
        </DialogClose>
      )}
    </PrimitiveFooter>
  );
}
