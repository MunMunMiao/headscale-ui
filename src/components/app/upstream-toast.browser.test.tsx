import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createToastManager,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  Toaster,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toast,
  useToastManager,
} from "@/components/ui/toast";

test("the default manager announces a titled toast and keeps its action and close keyboard-operable", async () => {
  const undo = vi.fn();
  await render(
    <Toaster timeout={0}>
      <button
        type="button"
        onClick={() =>
          toast.add({
            title: "Device renamed",
            description: "The new name is available to every client.",
            actionProps: { children: "Undo rename", onClick: undo },
          })
        }
      >
        Save device name
      </button>
    </Toaster>,
  );
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect
    .element(notifications.getByRole("dialog"))
    .not.toBeInTheDocument();
  const save = page.getByRole("button", { name: "Save device name" });
  await save.click();
  const notice = notifications.getByRole("dialog", { name: "Device renamed" });
  await expect.element(notice).toBeVisible();
  await expect
    .element(notice)
    .toHaveAccessibleDescription("The new name is available to every client.");
  expect(notice.element().querySelector('[data-slot="toast-icon"]')).toBeNull();
  await userEvent.keyboard("{F6}");
  await expect.element(notifications).toHaveFocus();
  await userEvent.keyboard("{Tab}{Tab}");
  const action = notice.getByRole("button", { name: "Undo rename" });
  await expect.element(action).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(undo).toHaveBeenCalledOnce();
  await expect.element(notice).toBeVisible();
  await userEvent.tab();
  const close = notice.getByRole("button", { name: "Close toast" });
  await expect.element(close).toHaveFocus();
  await expect.element(close.element().querySelector("svg")).toBeVisible();
  expect(close.element().querySelector("svg")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await userEvent.keyboard("{Enter}");
  await expect.element(notice).not.toBeInTheDocument();
  await expect.element(save).toHaveFocus();
});

test.each([
  ["success", "lucide-circle-check"],
  ["info", "lucide-info"],
  ["warning", "lucide-triangle-alert"],
  ["error", "lucide-octagon-x"],
  ["loading", "lucide-loader-circle"],
  ["custom", null],
] as const)(
  "a %s toast displays its own decorative status icon and dismisses on click",
  async (type, iconClass) => {
    const manager = createToastManager();
    const closed = vi.fn();
    await render(
      <Toaster toastManager={manager} timeout={0}>
        <button
          type="button"
          onClick={() =>
            manager.add({
              type,
              title: `${type} notification`,
              description: "Review this operation result.",
              onClose: closed,
            })
          }
        >
          Report operation
        </button>
      </Toaster>,
    );
    await page.getByRole("button", { name: "Report operation" }).click();
    const notice = page.getByRole("dialog", { name: `${type} notification` });
    await expect.element(notice).toBeVisible();
    await expect
      .element(notice)
      .toHaveAccessibleDescription("Review this operation result.");
    const icon = notice
      .element()
      .querySelector<HTMLElement>('[data-slot="toast-icon"]');
    if (iconClass) {
      await expect.element(icon).toBeVisible();
      expect(icon?.querySelector("svg")).toHaveClass(iconClass);
      expect(icon?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      if (type === "error")
        expect(icon?.querySelector("svg")).toHaveClass("text-destructive");
      if (type === "loading")
        expect(icon?.querySelector("svg")).toHaveClass("animate-spin");
    } else {
      expect(icon).toBeNull();
    }
    expect(
      notice.element().querySelector('[data-slot="toast-action"]'),
    ).toBeNull();
    await notice.hover();
    await notice.getByRole("button", { name: "Close toast" }).click();
    await expect.element(notice).not.toBeInTheDocument();
    expect(closed).toHaveBeenCalledOnce();
  },
);

function ComposedToasts({ onRetry }: { onRetry: () => void }) {
  const manager = useToastManager();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          manager.add({
            title: "Deployment interrupted",
            description: "Retry after checking the connection.",
          })
        }
      >
        Deploy changes
      </button>
      <ToastPortal>
        <ToastViewport
          aria-label="Deployment notices"
          className="custom-viewport"
        >
          {manager.toasts.map((item) => (
            <Toast key={item.id} toast={item} className="custom-toast">
              <ToastContent className="custom-content">
                <div>
                  <ToastTitle className="custom-title" />
                  <ToastDescription className="custom-description" />
                </div>
                <ToastAction
                  render={<button type="button" />}
                  className="custom-action"
                  onClick={onRetry}
                >
                  Retry deployment
                </ToastAction>
                <ToastClose
                  render={<button type="button" />}
                  className="custom-close"
                  aria-label="Dismiss deployment notice"
                >
                  Dismiss
                </ToastClose>
              </ToastContent>
            </Toast>
          ))}
        </ToastViewport>
      </ToastPortal>
    </>
  );
}

test("composed primitives retain custom rendering, descriptions, actions and close content", async () => {
  const retry = vi.fn();
  await render(
    <ToastProvider timeout={0}>
      <ComposedToasts onRetry={retry} />
    </ToastProvider>,
  );
  await page.getByRole("button", { name: "Deploy changes" }).click();
  const viewport = page.getByRole("region", { name: "Deployment notices" });
  const notice = viewport.getByRole("dialog", {
    name: "Deployment interrupted",
  });
  await expect.element(notice).toBeVisible();
  await expect
    .element(notice)
    .toHaveAccessibleDescription("Retry after checking the connection.");
  await expect.element(viewport).toHaveClass("custom-viewport");
  await expect.element(notice).toHaveClass("custom-toast");
  for (const slot of ["content", "title", "description"]) {
    expect(
      notice.element().querySelector(`[data-slot="toast-${slot}"]`),
    ).toHaveClass(`custom-${slot}`);
  }
  await notice.hover();
  const action = notice.getByRole("button", { name: "Retry deployment" });
  await expect.element(action).toHaveClass("custom-action");
  await action.click();
  expect(retry).toHaveBeenCalledOnce();
  const close = notice.getByRole("button", {
    name: "Dismiss deployment notice",
  });
  await expect.element(close).toHaveClass("custom-close");
  await expect.element(close).toHaveTextContent("Dismiss");
  expect(close.element().querySelector("svg")).toBeNull();
  await close.click();
  await expect.element(notice).not.toBeInTheDocument();
});
