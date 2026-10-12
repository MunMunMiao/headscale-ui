import { DirectionProvider } from "@base-ui/react/direction-provider";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { i18n, setLocale } from "@/i18n";
import { hydrateSettings } from "@/lib/settings-storage";
import AssignMemberDialog from "./AssignMemberDialog";
import MemberPicker, { type MemberOption } from "./MemberPicker";

function Assignment({ empty = false }) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState<string[]>([]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <AssignMemberDialog
        open={open}
        onOpenChange={setOpen}
        title="Assign groups"
        description="Choose memberships"
        options={
          empty
            ? []
            : [
                { id: "b", name: "Beta", assigned: false },
                { id: "a", name: "Alpha", assigned: true },
              ]
        }
        applyLabel="Apply"
        cancelLabel="Cancel"
        emptyLabel="No groups"
        assignedLabel="Assigned"
        testidPrefix="groups"
        onApply={setResult}
      />
      <output data-testid="result">{result.join(",")}</output>
    </>
  );
}
// Removing dirty tracking or initial assignment would permit a wrong group mutation.
test("assignment preserves current memberships and submits only the edited selection", async () => {
  await render(
    <I18nProvider i18n={i18n}>
      <Assignment />
    </I18nProvider>,
  );
  await expect.element(page.getByTestId("groups-apply")).toBeDisabled();
  await page.getByTestId("groups-option-b").click();
  await page.getByTestId("groups-option-a").click();
  await page.getByTestId("groups-apply").click();
  await expect.element(page.getByTestId("result")).toHaveTextContent("b");
  await page.getByTestId("groups-cancel").click();
  await page.getByText("Reopen", { exact: true }).click();
  await expect.element(page.getByTestId("groups-apply")).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("groups-dialog")).not.toBeInTheDocument();
});

test("cancelling a membership draft restores server assignments when reopened", async () => {
  await render(
    <I18nProvider i18n={i18n}>
      <Assignment />
    </I18nProvider>,
  );
  await page.getByTestId("groups-option-b").click();
  await page.getByTestId("groups-option-a").click();
  await expect.element(page.getByTestId("groups-apply")).toBeEnabled();
  await page.getByTestId("groups-cancel").click();
  await expect.element(page.getByTestId("groups-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("result")).toBeEmptyDOMElement();
  await page.getByText("Reopen", { exact: true }).click();
  await expect.element(page.getByRole("checkbox", { name: "Alpha Assigned" })).toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: "Beta" })).not.toBeChecked();
  await expect.element(page.getByTestId("groups-apply")).toBeDisabled();
});

test("an empty assignment list explains its state and permits cancellation without applying", async () => {
  await render(
    <I18nProvider i18n={i18n}>
      <Assignment empty />
    </I18nProvider>,
  );
  await expect.element(page.getByTestId("groups-empty")).toHaveTextContent("No groups");
  await expect.element(page.getByTestId("groups-apply")).toBeDisabled();
  await page.getByTestId("groups-cancel").click();
  await expect.element(page.getByTestId("groups-dialog")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("result")).toBeEmptyDOMElement();
});
const memberOptions: MemberOption[] = [
  { value: "alice@", label: "Alice", description: "Operations", group: "People" },
  { value: "bob@", label: "Bob", group: "People" },
  { value: "group:home", label: "Home", group: "Groups", groupOrder: 1 },
  { value: "ungrouped@", label: "Ungrouped" },
];

function ActionPicker({ disabled = false, options = memberOptions }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [submits, setSubmits] = useState(0);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSubmits((count) => count + 1);
      }}
    >
      <MemberPicker
        onPick={(value) => setPicked((current) => [...current, value])}
        options={options}
        triggerLabel="Members"
        searchPlaceholder="Find a member"
        emptyText="No matching members"
        testid="picker"
        disabled={disabled}
      />
      <output data-testid="picked">{picked.join(",")}</output>
      <output data-testid="submits">{submits}</output>
    </form>
  );
}

// Missing names make the action list and its search indistinguishable in assistive technology.
test("names the action picker and supports keyboard-only addition without form submission", async () => {
  await render(<ActionPicker />);
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("picker-content")).toHaveAccessibleName("Members");
  await expect.element(page.getByTestId("picker-search")).toHaveAccessibleName("Find a member");
  await expect.element(page.getByTestId("picker-search")).toHaveFocus();
  await expect.element(page.getByRole("group", { name: "People" })).toBeVisible();
  await page.getByTestId("picker-search").fill("  OPERATIONS  ");
  await userEvent.tab();
  await expect.element(page.getByTestId("picker-option-alice@")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("picked")).toHaveTextContent("alice@");
  await expect.element(page.getByTestId("submits")).toHaveTextContent("0");
  await expect.element(page.getByTestId("picker-content")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("picker-trigger")).toHaveFocus();
});

// Disabling only the trigger leaves an already open action list able to mutate a policy.
test("disables actions when an already open picker becomes disabled", async () => {
  const view = await render(<ActionPicker />);
  await page.getByTestId("picker-trigger").click();
  await view.rerender(<ActionPicker disabled />);
  await expect.element(page.getByTestId("picker-option-alice@")).toBeDisabled();
  await expect.element(page.getByTestId("picked")).toBeEmptyDOMElement();
  const option = page.getByTestId("picker-option-alice@").element();
  if (!(option instanceof HTMLButtonElement)) throw new Error("Member action is not a button");
  option.click();
  await expect.element(page.getByTestId("picked")).toBeEmptyDOMElement();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("picker-trigger")).toBeDisabled();
});

test("keeps candidate grouping and searches labels and values without retaining a closed query", async () => {
  await render(<ActionPicker />);
  await page.getByTestId("picker-trigger").click();
  expect(
    Array.from(document.querySelectorAll('[data-testid^="picker-option-"]')).map((element) =>
      element.getAttribute("data-testid"),
    ),
  ).toEqual([
    "picker-option-group:home",
    "picker-option-alice@",
    "picker-option-bob@",
    "picker-option-ungrouped@",
  ]);
  await page.getByTestId("picker-search").fill("GROUP:HOME");
  await expect.element(page.getByTestId("picker-option-group:home")).toBeVisible();
  await expect.element(page.getByTestId("picker-option-alice@")).not.toBeInTheDocument();
  await page.getByTestId("picker-search").fill(" aLiCe ");
  await expect.element(page.getByTestId("picker-option-alice@")).toBeVisible();
  await page.getByTestId("picker-search").fill("not-present");
  await expect.element(page.getByTestId("picker-empty")).toHaveAttribute("role", "status");
  await expect.element(page.getByTestId("picker-empty")).toHaveTextContent("No matching members");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("picker-trigger")).toHaveFocus();
  await page.getByTestId("picker-trigger").click();
  await expect.element(page.getByTestId("picker-search")).toHaveValue("");
});

test.each([
  { width: 360, height: 568, direction: "rtl" as const, dark: true },
  { width: 390, height: 844, direction: "ltr" as const, dark: false },
])("keeps keyboard actions visible in a $width by $height $direction dialog", async (viewport) => {
  await page.viewport(viewport.width, viewport.height);
  document.documentElement.dir = viewport.direction;
  document.documentElement.classList.toggle("dark", viewport.dark);
  const options = Array.from({ length: 16 }, (_, index) => ({
    value: `member-${index}@`,
    label: `عضو الفريق ${index}`,
    description: "فريق العمليات",
    group: "الأعضاء",
  }));
  try {
    await render(
      <I18nProvider i18n={i18n}>
        <DirectionProvider direction={viewport.direction}>
          <Dialog defaultOpen>
            <DialogContent data-testid="parent-dialog">
              <DialogTitle>Team members</DialogTitle>
              <ActionPicker options={options} />
            </DialogContent>
          </Dialog>
        </DirectionProvider>
      </I18nProvider>,
    );
    await expect.element(page.getByTestId("picker-trigger")).toHaveFocus();
    await page.getByTestId("picker-trigger").click();
    await expect.element(page.getByTestId("picker-search")).toHaveFocus();
    for (const _option of options) await userEvent.tab();
    await expect.element(page.getByTestId("picker-option-member-15@")).toHaveFocus();
    const popup = page.getByTestId("picker-content").element().getBoundingClientRect();
    const list = page.getByTestId("picker-list").element().getBoundingClientRect();
    const last = page.getByTestId("picker-option-member-15@").element().getBoundingClientRect();
    expect(popup.left).toBeGreaterThanOrEqual(0);
    expect(popup.right).toBeLessThanOrEqual(viewport.width);
    expect(popup.top).toBeGreaterThanOrEqual(0);
    expect(popup.bottom).toBeLessThanOrEqual(viewport.height);
    expect(last.top).toBeGreaterThanOrEqual(list.top);
    expect(last.bottom).toBeLessThanOrEqual(list.bottom);
    await userEvent.keyboard(" ");
    await expect.element(page.getByTestId("picked")).toHaveTextContent("member-15@");
    await expect.element(page.getByTestId("picker-trigger")).toHaveFocus();
    await expect.element(page.getByTestId("parent-dialog")).toBeVisible();
    await page.getByTestId("picker-trigger").click();
    await expect.element(page.getByTestId("picker-search")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("picker-content")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("parent-dialog")).toBeVisible();
    await expect.element(page.getByTestId("picker-trigger")).toHaveFocus();
  } finally {
    document.documentElement.dir = "ltr";
    document.documentElement.classList.remove("dark");
    await page.viewport(1280, 720);
  }
});

function optionNames() {
  return Array.from(document.querySelectorAll("[data-testid^='groups-option-']")).map(
    (el) => el.textContent,
  );
}

// Assignment order must follow the active locale's collation, not UTF-16 order.
test.each([
  ["es-ES", ["ñandú", "nube"], ["nube", "ñandú"]],
  ["zh-Hans", ["张", "李", "王"], ["李", "王", "张"]],
])("assignment options sort with the %s collation", async (locale, names, expected) => {
  await hydrateSettings();
  await setLocale(locale as "es-ES" | "zh-Hans");
  try {
    await render(
      <I18nProvider i18n={i18n}>
        <AssignMemberDialog
          open
          onOpenChange={() => {}}
          title="Assign"
          description="Choose"
          options={names.map((name) => ({ id: name, name, assigned: false }))}
          applyLabel="Apply"
          cancelLabel="Cancel"
          emptyLabel="None"
          assignedLabel="Assigned"
          testidPrefix="groups"
          onApply={() => {}}
        />
      </I18nProvider>,
    );
    await expect.element(page.getByTestId(`groups-option-${names[0]}`)).toBeVisible();
    expect(optionNames()).toEqual(expected);
  } finally {
    await setLocale("en-US");
  }
});

test("assignment rows are checkboxes whose state flips on click and Space and which lock while submitting", async () => {
  function Rows({ isSubmitting = false }) {
    return (
      <I18nProvider i18n={i18n}>
        <AssignMemberDialog
          open
          onOpenChange={() => {}}
          title="Assign"
          description="Choose"
          options={[
            { id: "a", name: "Alpha", assigned: true },
            { id: "b", name: "Beta", assigned: false },
          ]}
          applyLabel="Apply"
          cancelLabel="Cancel"
          emptyLabel="None"
          assignedLabel="Assigned"
          testidPrefix="groups"
          isSubmitting={isSubmitting}
          onApply={() => {}}
        />
      </I18nProvider>
    );
  }
  const view = await render(<Rows />);
  expect(page.getByRole("checkbox").elements().length).toBe(2);
  const beta = page.getByTestId("groups-option-b");
  await expect.element(beta).toHaveAttribute("role", "checkbox");
  await expect.element(beta).toHaveAttribute("aria-checked", "false");
  await beta.click();
  await expect.element(beta).toHaveAttribute("aria-checked", "true");
  beta.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(beta).toHaveAttribute("aria-checked", "false");
  await view.rerender(<Rows isSubmitting />);
  await expect.element(beta).toBeDisabled();
  // A disabled row ignores activation, so the selection cannot change during submission.
  (beta.element() as HTMLButtonElement).click();
  await expect.element(beta).toHaveAttribute("aria-checked", "false");
});

// 16px prevents iOS from zooming on focus; desktop keeps the compact size.
test("native select uses 16px text at narrow widths and 14px on desktop", async () => {
  await render(<NativeSelect aria-label="Pick" />);
  const size = () => getComputedStyle(page.getByRole("combobox").element()).fontSize;
  try {
    await page.viewport(360, 640);
    await expect.poll(size).toBe("16px");
    await page.viewport(1024, 768);
    await expect.poll(size).toBe("14px");
  } finally {
    await page.viewport(414, 896);
  }
});
