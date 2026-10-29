import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useSession } from "@/composables/session-context";
import type { NotificationData } from "@/composables/useActionFeedback";
import { useHeadscaleI18n } from "@/i18n";
import { Notice } from "./notice";

function NotificationViewport() {
  const { toasts, close } = Toast.useToastManager<NotificationData>();
  const { t } = useHeadscaleI18n();
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    const active = element?.ownerDocument.activeElement;
    if (
      !active ||
      !element?.contains(active) ||
      !active.closest('[data-slot="toast"][data-ending-style]')
    )
      return;
    // The library can select a hidden group member. Repair only focus still
    // stranded in an exiting toast, before that node is removed.
    element
      .querySelector<HTMLElement>(
        '[data-slot="toast"]:not([data-limited]):not([data-ending-style])',
      )
      ?.focus({ preventScroll: true });
  }, [toasts]);
  const representedGroups = new Set<string>();
  let visibleToasts = 0;
  return (
    <Toast.Portal>
      <Toast.Viewport
        ref={viewport}
        data-slot="notification-viewport"
        aria-label={t("notifications")}
        className="pointer-events-none fixed end-4 bottom-4 z-60 flex w-[calc(100%-2rem)] max-w-sm flex-col-reverse gap-2 outline-none"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Toast.Root handles its own Escape; do not also dismiss an underlying modal.
          event.stopPropagation();
          if (event.target === event.currentTarget) {
            const first = toasts.find(
              (toast) => toast.transitionStatus !== "ending",
            );
            if (first) close(first.id);
          }
        }}
      >
        {toasts.map((toast) => {
          const group = toast.data?.refreshGroup;
          const merged = group !== undefined && representedGroups.has(group);
          if (group !== undefined) representedGroups.add(group);
          const limited =
            merged ||
            (toast.transitionStatus === "ending"
              ? toast.limited
              : visibleToasts++ >= 3);
          return (
            <Toast.Root
              key={toast.id}
              toast={{ ...toast, limited }}
              data-slot="toast"
              className="pointer-events-auto w-full rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-100 focus-visible:ring-2 focus-visible:ring-ring data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-limited:hidden"
            >
              <Toast.Content>
                <Notice
                  tone={toast.data?.tone ?? "info"}
                  className="border-0 bg-transparent p-0"
                  title={<Toast.Title />}
                  action={
                    <Toast.Close
                      aria-hidden={false}
                      aria-label={t("close")}
                      className="flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <XIcon aria-hidden="true" className="size-4" />
                    </Toast.Close>
                  }
                >
                  <Toast.Description className="text-muted-foreground" />
                </Notice>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function NotificationHost() {
  const { feedback } = useSession();
  return (
    <Toast.Provider
      toastManager={feedback.toastManager}
      timeout={4000}
      limit={3}
    >
      <NotificationViewport />
    </Toast.Provider>
  );
}
