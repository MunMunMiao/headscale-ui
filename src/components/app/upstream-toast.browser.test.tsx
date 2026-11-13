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
  expect(close.element().querySelector("svg")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await userEvent.keyboard("{Enter}");
  await expect.element(notice).not.toBeInTheDocument();
  await expect.element(save).toHaveFocus();
});

test.each([
  "success",
  "info",
  "warning",
  "error",
  "loading",
  "custom",
] as const)(
  "a %s toast announces its result and dismisses on click",
  async (type) => {
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
    if (type !== "custom") {
      expect(
        notice.element().querySelector('[data-slot="toast-icon"] svg'),
      ).toHaveAttribute("aria-hidden", "true");
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
        <ToastViewport aria-label="Deployment notices">
          {manager.toasts.map((item) => (
            <Toast key={item.id} toast={item}>
              <ToastContent>
                <div>
                  <ToastTitle />
                  <ToastDescription />
                </div>
                <ToastAction
                  render={<button type="button" />}
                  onClick={onRetry}
                >
                  Retry deployment
                </ToastAction>
                <ToastClose
                  render={<button type="button" />}
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
  await notice.hover();
  const action = notice.getByRole("button", { name: "Retry deployment" });
  await action.click();
  expect(retry).toHaveBeenCalledOnce();
  const close = notice.getByRole("button", {
    name: "Dismiss deployment notice",
  });
  await expect.element(close).toHaveTextContent("Dismiss");
  await close.click();
  await expect.element(notice).not.toBeInTheDocument();
});
