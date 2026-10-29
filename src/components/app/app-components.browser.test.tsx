import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AlertDialogHeader } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "./native-select";

const modules = import.meta.glob("./*.tsx");
const originalDirection = document.documentElement.dir;

afterEach(async () => {
  document.documentElement.dir = originalDirection;
  await page.viewport(1280, 720);
});

test.each([
  ["form", "useAppForm"],
  ["notification-host", "NotificationHost"],
  ["tooltip", "Tooltip"],
  ["notice", "Notice"],
  ["copy-button", "CopyButton"],
  ["date-time-picker", "DateTimePicker"],
  ["time-picker", "TimePicker"],
])(
  "%s exposes its application API outside the upstream primitive directory",
  async (name, api) => {
    const load = modules[`./${name}.tsx`];
    expect(load).toBeTypeOf("function");
    const component = await load?.();
    expect(component).toHaveProperty(api, expect.any(Function));
  },
);

test("global styles give enabled controls pointer cursors and disabled controls not-allowed cursors", async () => {
  const view = await render(
    <button type="button" data-slot="button">
      Primitive control
    </button>,
  );
  const control = page.getByRole("button", { name: "Primitive control" });
  expect(getComputedStyle(control.element()).cursor).toBe("pointer");
  await view.rerender(
    <button type="button" data-slot="button" disabled>
      Primitive control
    </button>,
  );
  expect(getComputedStyle(control.element()).cursor).toBe("not-allowed");
});

test.each(["ltr", "rtl"])(
  "application selects retain a 36px target and put the icon at inline-end in %s",
  async (direction) => {
    document.documentElement.dir = direction;
    await render(
      <NativeSelect aria-label="Filter" className="[&_select]:ps-8">
        <NativeSelectOption>All devices</NativeSelectOption>
      </NativeSelect>,
    );
    const select = page.getByRole("combobox", { name: "Filter" }).element();
    expect(select.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
    expect(getComputedStyle(select).paddingInlineStart).toBe("32px");
    const wrapper = select.closest('[data-slot="native-select-wrapper"]');
    const icon = wrapper?.querySelector('[data-slot="native-select-icon"]');
    expect.assert(wrapper && icon);
    const bounds = wrapper.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    const left = Math.abs(iconBounds.left - bounds.left);
    const right = Math.abs(bounds.right - iconBounds.right);
    expect(direction === "rtl" ? left : right).toBeLessThan(
      direction === "rtl" ? right : left,
    );
  },
);

test.each(["default", "sm"] as const)(
  "a %s switch moves its checked thumb toward inline-end in RTL",
  async (size) => {
    document.documentElement.dir = "rtl";
    const view = await render(
      <Switch size={size} aria-label="Reusable" checked={false} />,
    );
    const control = page.getByRole("switch", { name: "Reusable" });
    const thumbCenter = () => {
      const bounds = control
        .element()
        .querySelector('[data-slot="switch-thumb"]')
        ?.getBoundingClientRect();
      expect.assert(bounds);
      return bounds.left + bounds.width / 2;
    };
    const bounds = control.element().getBoundingClientRect();
    const center = bounds.left + bounds.width / 2;
    expect(thumbCenter()).toBeGreaterThan(center);
    await view.rerender(<Switch size={size} aria-label="Reusable" checked />);
    expect(thumbCenter()).toBeLessThan(center);
  },
);

test("application alert headers align with the Arabic inline start", async () => {
  await page.viewport(1366, 768);
  document.documentElement.dir = "rtl";
  await render(
    <div
      className="group/alert-dialog-content"
      data-slot="alert-dialog-content"
      data-size="default"
    >
      <AlertDialogHeader>Approve route</AlertDialogHeader>
    </div>,
  );
  const header = document.querySelector('[data-slot="alert-dialog-header"]');
  expect.assert(header);
  expect(getComputedStyle(header).textAlign).toMatch(/^(right|start)$/);
});
