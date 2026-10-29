import { useState } from "react";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { type Locale, SUPPORTED_LOCALES } from "@/i18n/locales";
import { getProductCopy } from "@/i18n/product-copy";
import { loadLocale } from "@/i18n/runtime";
import { formatDate } from "@/utils/format";
import { DateTimePicker } from "./date-time-picker";
import { TimePicker } from "./time-picker";

// The render harness tags its own container, so only picker-owned test ids count.
const NO_TEST_ID = '[data-testid]:not([data-testid^="__vitest"])';

function DateHarness({
  locale = "en-US",
  initial = "2026-06-01T13:45",
  error,
}: {
  locale?: Locale;
  initial?: string;
  error?: string;
}) {
  const [value, setValue] = useState(initial);
  const copy = getProductCopy(locale);
  return (
    <>
      <DateTimePicker
        value={value}
        onValueChange={setValue}
        testId="expiry"
        locale={locale}
        placeholder={copy.dateTimePlaceholder}
        timeLabel={copy.time}
        hourLabel={copy.hour}
        minuteLabel={copy.minute}
        error={error}
      />
      <output data-testid="value">{value}</output>
      <button type="button" onClick={() => setValue("")}>
        Clear
      </button>
    </>
  );
}

function Availability({ disabled }: { disabled: boolean }) {
  const [value, setValue] = useState("2026-06-01T13:45");
  const copy = getProductCopy("en-US");
  return (
    <>
      <DateTimePicker
        value={value}
        onValueChange={setValue}
        disabled={disabled}
        testId="expiry"
        placeholder={copy.dateTimePlaceholder}
        timeLabel={copy.time}
        hourLabel={copy.hour}
        minuteLabel={copy.minute}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

test("a disabled date field cannot open or keep editing an existing popup", async () => {
  const view = await render(<Availability disabled />);
  await expect.element(page.getByTestId("expiry")).toBeDisabled();
  await view.rerender(<Availability disabled={false} />);
  await page.getByTestId("expiry").click();
  await page.getByTestId("expiry-hour").selectOptions("16");
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-01T16:45");
  await view.rerender(<Availability disabled />);
  await expect.element(page.getByTestId("expiry")).toBeDisabled();
  await expect.element(page.getByTestId("expiry-hour")).not.toBeInTheDocument();
  await view.rerender(<Availability disabled={false} />);
  await expect.element(page.getByTestId("expiry")).toBeEnabled();
  await expect.element(page.getByTestId("expiry-hour")).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-01T16:45");
});

test("date field blur reports leaving the closed trigger and dismissing the popup", async () => {
  const blurred: string[] = [];
  const copy = getProductCopy("en-US");
  await render(
    <>
      <DateTimePicker
        value="2026-06-01T13:45"
        onValueChange={() => {}}
        onBlur={() => blurred.push("blur")}
        testId="expiry"
        placeholder={copy.dateTimePlaceholder}
        timeLabel={copy.time}
        hourLabel={copy.hour}
        minuteLabel={copy.minute}
      />
      <button type="button">Next field</button>
    </>,
  );
  (page.getByTestId("expiry").element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Tab}");
  expect(blurred).toEqual(["blur"]);
  await page.getByTestId("expiry").click();
  await expect.element(page.getByTestId("expiry-hour")).toBeVisible();
  const beforeClose = blurred.length;
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => blurred.length).toBeGreaterThan(beforeClose);
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
});

function Harness() {
  const [value, setValue] = useState("9:45:12");
  return (
    <>
      <TimePicker value={value} onValueChange={setValue} testIdPrefix="clock" />
      <output>{value}</output>
    </>
  );
}

test("time selections preserve the other field and normalize legacy seconds", async () => {
  await render(<Harness />);
  await expect.element(page.getByTestId("clock-hour")).toHaveValue("09");
  await page.getByTestId("clock-hour").selectOptions("23");
  await expect.element(page.getByRole("status")).toHaveTextContent("23:45");
  await page.getByTestId("clock-minute").selectOptions("59");
  await expect.element(page.getByRole("status")).toHaveTextContent("23:59");
});

test("invalid time resets safely and Arabic option labels use native digits", async () => {
  await render(
    <TimePicker
      value="24:60"
      onValueChange={() => {}}
      locale="ar-EG"
      testIdPrefix="clock"
      disabled
    />,
  );
  await expect.element(page.getByTestId("clock-hour")).toHaveValue("00");
  await expect.element(page.getByTestId("clock-hour")).toBeDisabled();
  expect(
    document.querySelector('[data-testid="clock-hour"] option[value="23"]')
      ?.textContent,
  ).toBe("٢٣");
  expect(
    document.querySelector('[data-testid="clock-minute"] option[value="59"]')
      ?.textContent,
  ).toBe("٥٩");
});

test("local date selection and time edits emit datetime-local without UTC conversion", async () => {
  await render(<DateHarness />);
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveTextContent(formatDate("2026-06-01T13:45", "en-US", ""));
  await expect
    .element(page.getByTestId("expiry"))
    .toMatchTextContent("Jun 1, 2026");
  expect(document.querySelector('[data-slot="time-picker"]')).toBeNull();
  await page.getByTestId("expiry").click();
  await expect
    .poll(
      () => document.querySelectorAll('[data-slot="calendar"] select').length,
    )
    .toBe(2);
  await page.getByTestId("expiry-hour").selectOptions("00");
  await page.getByTestId("expiry-minute").selectOptions("05");
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-01T00:05");
  await page
    .getByRole("button", { name: "Tuesday, June 2nd, 2026", exact: true })
    .click();
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-02T00:05");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
  await page.getByText("Clear", { exact: true }).click();
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveTextContent("Pick date and time");
});

test("keyboard date editing starts on the selected day and preserves its time", async () => {
  const submissions: string[] = [];
  await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submissions.push("submit");
      }}
    >
      <DateHarness />
    </form>,
  );
  await userEvent.tab();
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      page.getByRole("button", {
        name: "Monday, June 1st, 2026, selected",
        exact: true,
      }),
    )
    .toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(
      page.getByRole("button", {
        name: "Tuesday, June 2nd, 2026",
        exact: true,
      }),
    )
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-02T13:45");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
  expect(submissions).toEqual([]);
});

test("keyboard opening falls back to the first popup control when no calendar day can receive initial focus", async () => {
  const nativeQuery = HTMLDivElement.prototype.querySelector;
  const query = vi
    .spyOn(HTMLDivElement.prototype, "querySelector")
    .mockImplementation(function (this: HTMLDivElement, selector: string) {
      // 仅模拟日历尚未给出可 Tab 到达的日期，其余 DOM 查询保持真实。
      if (
        this.dataset.slot === "popover-content" &&
        selector === 'button[tabindex="0"]'
      )
        return null;
      return nativeQuery.call(this, selector);
    });
  try {
    await render(<DateHarness />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("button", { name: "Go to the Previous Month" }))
      .toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByTestId("expiry")).toHaveFocus();
    await expect
      .element(page.getByTestId("value"))
      .toHaveTextContent("2026-06-01T13:45");
  } finally {
    query.mockRestore();
  }
});

test("Arabic picker localizes calendar and time labels and fits a short viewport", async () => {
  await loadLocale("ar");
  await page.viewport(360, 568);
  document.documentElement.dir = "rtl";
  document.documentElement.classList.add("dark");
  try {
    await render(<DateHarness locale="ar" />);
    await page.getByTestId("expiry").click();
    await expect
      .element(page.getByTestId("expiry-time-label"))
      .toHaveTextContent("الوقت");
    await expect.element(page.getByTestId("expiry-hour")).toHaveValue("13");
    await expect
      .poll(() => {
        const r = document
          .querySelector('[data-slot="popover-content"]')
          ?.getBoundingClientRect();
        return (
          !!r && r.left >= 0 && r.right <= 360 && r.top >= 0 && r.bottom <= 568
        );
      })
      .toBe(true);
  } finally {
    document.documentElement.dir = "ltr";
    document.documentElement.classList.remove("dark");
    await page.viewport(1280, 720);
  }
});

test("choosing time before a date keeps the value empty and applies that time to the selected date", async () => {
  await render(<DateHarness initial="" />);
  await page.getByTestId("expiry").click();
  await page.getByTestId("expiry-hour").selectOptions("16");
  await page.getByTestId("expiry-minute").selectOptions("15");
  await expect.element(page.getByTestId("value")).toHaveTextContent("");
  await page
    .getByRole("combobox", { name: "Choose the Year" })
    .selectOptions("2026");
  await page
    .getByRole("combobox", { name: "Choose the Month" })
    .selectOptions("5");
  await page
    .getByRole("button", { name: "Tuesday, June 2nd, 2026", exact: true })
    .click();
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-02T16:15");
});

test("shows Traditional Chinese copy for an empty date instead of a simplified fallback", async () => {
  await loadLocale("zh-Hant-TW");
  await render(<DateHarness locale="zh-Hant-TW" initial="" />);
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveTextContent("選擇日期和時間");
});

function Labelled({ error }: { error?: string }) {
  const copy = getProductCopy("en-US");
  return (
    <DateTimePicker
      id="expiry-field"
      value="2026-06-01T13:45"
      onValueChange={() => {}}
      testId="expiry"
      placeholder={copy.dateTimePlaceholder}
      timeLabel={copy.time}
      hourLabel={copy.hour}
      minuteLabel={copy.minute}
      error={error}
    />
  );
}

// An invalid expiration needs visible feedback associated with the field.
test("shows an error message linked to the trigger", async () => {
  const view = await render(<Labelled error="Pick a later time" />);
  await expect
    .element(page.getByTestId("expiry-error"))
    .toHaveTextContent("Pick a later time");
  await expect
    .element(page.getByTestId("expiry-error"))
    .toHaveAttribute("id", "expiry-field-error");
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveAttribute(
      "aria-describedby",
      "expiry-field-value expiry-field-error",
    );
  await view.rerender(<Labelled />);
  await expect
    .element(page.getByTestId("expiry-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("expiry"))
    .not.toHaveAttribute("aria-invalid");
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveAttribute("aria-describedby", "expiry-field-value");
});

// Catches calendar chrome that stays English when the UI locale is not.
test.each(SUPPORTED_LOCALES.filter((locale) => locale !== "en-US"))(
  "calendar controls are localized for %s",
  async (locale) => {
    await loadLocale(locale);
    await render(<DateHarness locale={locale} />);
    await page.getByTestId("expiry").click();
    await expect
      .poll(
        () => document.querySelectorAll('[data-slot="calendar"] select').length,
      )
      .toBe(2);
    expect(
      page.getByRole("button", { name: "Go to the Previous Month" }).elements(),
    ).toEqual([]);
    expect(
      page.getByRole("combobox", { name: "Choose the Year" }).elements(),
    ).toEqual([]);
  },
);

test.each([
  ["ar", "اذهب إلى الشهر السابق", "اختر السنة"],
  ["ja-JP", "前の月へ", "年を選択"],
  ["zh-Hant-HK", "前往上個月", "選擇年份"],
] as const)(
  "calendar uses the library's %s strings",
  async (locale, previous, year) => {
    await loadLocale(locale);
    await render(<DateHarness locale={locale} />);
    await page.getByTestId("expiry").click();
    await expect
      .element(page.getByRole("button", { name: previous }))
      .toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: year }))
      .toBeVisible();
  },
);

test("English calendar keeps its English names", async () => {
  await render(<DateHarness />);
  await page.getByTestId("expiry").click();
  await expect
    .element(page.getByRole("button", { name: "Go to the Previous Month" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: "Choose the Year" }))
    .toBeVisible();
});

// Catches a popup and time controls that screen readers cannot name or relate to the value.
test("the popup, time group and trigger expose accessible names", async () => {
  await render(<DateHarness />);
  const trigger = page.getByTestId("expiry");
  const shown = formatDate("2026-06-01T13:45", "en-US", "");
  await trigger.click();
  await expect.element(page.getByRole("dialog", { name: shown })).toBeVisible();
  const group = page.getByRole("group", { name: "Time" });
  await expect.element(group).toBeVisible();
  await expect.element(group.getByLabelText("Hour")).toBeVisible();
  await expect.element(group.getByLabelText("Minute")).toBeVisible();
  await expect.element(trigger).not.toHaveAttribute("aria-required");
  const describedBy = trigger.element().getAttribute("aria-describedby") ?? "";
  expect(
    describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent),
  ).toEqual([shown]);
});

test("a time picker without a value starts at midnight and needs no test id", async () => {
  const changes: string[] = [];
  await render(<TimePicker onValueChange={(next) => changes.push(next)} />);
  await expect.element(page.getByLabelText("Hour")).toHaveValue("00");
  await expect.element(page.getByLabelText("Minute")).toHaveValue("00");
  expect(document.querySelector(NO_TEST_ID)).toBeNull();
  await page.getByLabelText("Hour").selectOptions("07");
  expect(changes).toEqual(["07:00"]);
});

function Unlabelled() {
  return (
    <>
      {["first", "second"].map((name) => (
        <DateTimePicker
          key={name}
          value="2026-06-01T13:45"
          onValueChange={() => {}}
          placeholder="Pick"
          timeLabel="Time"
          hourLabel="Hour"
          minuteLabel="Minute"
          error={`${name} error`}
        />
      ))}
    </>
  );
}

// Catches ids that collide or dangle when callers give the picker neither an id nor a test id.
test("generated ids link the trigger, the error and the time group without a test id", async () => {
  await render(<Unlabelled />);
  const triggers = Array.from(
    document.querySelectorAll<HTMLElement>("button[aria-describedby]"),
  );
  expect(triggers).toHaveLength(2);
  const ids = triggers.map(
    (trigger) => trigger.getAttribute("aria-describedby") ?? "",
  );
  expect(new Set(ids.flatMap((value) => value.split(" "))).size).toBe(4);
  const messages = ids.map((value) =>
    value.split(" ").map((id) => document.getElementById(id)?.textContent),
  );
  expect(messages[0]?.[1]).toBe("first error");
  expect(messages[1]?.[1]).toBe("second error");
  await triggers[0]?.click();
  const group = page.getByRole("group", { name: "Time" });
  await expect.element(group).toBeVisible();
  await expect.element(group.getByLabelText("Hour")).toHaveValue("13");
  expect(document.querySelector(NO_TEST_ID)).toBeNull();
});

// Catches the expiry being silently emptied when the selected day is clicked a second time.
test("clicking the selected day again keeps the value", async () => {
  await render(<DateHarness />);
  await page.getByTestId("expiry").click();
  await expect
    .poll(
      () => document.querySelectorAll('[data-slot="calendar"] select').length,
    )
    .toBe(2);
  await page
    .getByRole("button", {
      name: "Monday, June 1st, 2026, selected",
      exact: true,
    })
    .click();
  await expect
    .element(page.getByTestId("value"))
    .toHaveTextContent("2026-06-01T13:45");
  await expect
    .element(page.getByTestId("expiry"))
    .toMatchTextContent("Jun 1, 2026");
});
