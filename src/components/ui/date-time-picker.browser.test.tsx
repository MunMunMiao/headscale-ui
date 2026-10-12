import { useState } from "react";
import { expect, test } from "vitest";
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

test("time selections preserve the other field and normalize legacy seconds", async () => {
  function Harness() {
    const [value, setValue] = useState("9:45:12");
    return (
      <>
        <TimePicker value={value} onValueChange={setValue} testIdPrefix="clock" />
        <output>{value}</output>
      </>
    );
  }
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
  expect(document.querySelector('[data-testid="clock-hour"] option[value="23"]')?.textContent).toBe(
    "٢٣",
  );
  expect(
    document.querySelector('[data-testid="clock-minute"] option[value="59"]')?.textContent,
  ).toBe("٥٩");
});

test("local date selection and time edits emit datetime-local without UTC conversion", async () => {
  await render(<DateHarness />);
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveTextContent(formatDate("2026-06-01T13:45", "en-US", ""));
  await expect.element(page.getByTestId("expiry")).toMatchTextContent("Jun 1, 2026");
  expect(document.querySelector('[data-slot="time-picker"]')).toBeNull();
  await page.getByTestId("expiry").click();
  await expect
    .poll(() => document.querySelectorAll('[data-slot="calendar"] select').length)
    .toBe(2);
  await page.getByTestId("expiry-hour").selectOptions("00");
  await page.getByTestId("expiry-minute").selectOptions("05");
  await expect.element(page.getByTestId("value")).toHaveTextContent("2026-06-01T00:05");
  const day = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-cell-trigger"]'),
  ).find((el) => el.textContent?.trim() === "2" && !el.closest('[data-outside="true"]'));
  if (!day) throw new Error("Second day is missing");
  day.click();
  await expect.element(page.getByTestId("value")).toHaveTextContent("2026-06-02T00:05");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("expiry")).toHaveFocus();
  await page.getByText("Clear", { exact: true }).click();
  await expect.element(page.getByTestId("expiry")).toHaveTextContent("Pick date and time");
});

test("Arabic picker localizes calendar and time labels and fits a short viewport", async () => {
  await loadLocale("ar");
  await page.viewport(360, 568);
  document.documentElement.dir = "rtl";
  document.documentElement.classList.add("dark");
  try {
    await render(<DateHarness locale="ar" />);
    await page.getByTestId("expiry").click();
    await expect.element(page.getByTestId("expiry-time-label")).toHaveTextContent("الوقت");
    await expect.element(page.getByTestId("expiry-hour")).toHaveValue("13");
    await expect
      .poll(() => {
        const r = document.querySelector('[data-slot="popover-content"]')?.getBoundingClientRect();
        return !!r && r.left >= 0 && r.right <= 360 && r.top >= 0 && r.bottom <= 568;
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
  const day = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-cell-trigger"]'),
  ).find((el) => el.textContent?.trim() === "2" && !el.closest('[data-outside="true"]'));
  if (!day) throw new Error("Second day is missing");
  day.click();
  await expect.element(page.getByTestId("value")).toMatchTextContent(/T16:15$/);
});

test("shows Traditional Chinese copy for an empty date instead of a simplified fallback", async () => {
  await loadLocale("zh-Hant-TW");
  await render(<DateHarness locale="zh-Hant-TW" initial="" />);
  await expect.element(page.getByTestId("expiry")).toHaveTextContent("選擇日期和時間");
});

// Catches an invalid expiration that is only coloured, not announced or associated with the field.
test("exposes an error message as an alert linked to the trigger", async () => {
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
  const view = await render(<Labelled error="Pick a later time" />);
  await expect.element(page.getByRole("alert")).toHaveTextContent("Pick a later time");
  await expect
    .element(page.getByTestId("expiry-error"))
    .toHaveAttribute("id", "expiry-field-error");
  await expect.element(page.getByTestId("expiry")).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("expiry"))
    .toHaveAttribute("aria-describedby", "expiry-field-value expiry-field-error");
  await view.rerender(<Labelled />);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await expect.element(page.getByTestId("expiry")).not.toHaveAttribute("aria-invalid");
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
      .poll(() => document.querySelectorAll('[data-slot="calendar"] select').length)
      .toBe(2);
    expect(page.getByRole("button", { name: "Go to the Previous Month" }).elements()).toEqual([]);
    expect(page.getByRole("combobox", { name: "Choose the Year" }).elements()).toEqual([]);
  },
);

test.each([
  ["ar", "اذهب إلى الشهر السابق", "اختر السنة"],
  ["ja-JP", "前の月へ", "年を選択"],
  ["zh-Hant-HK", "前往上個月", "選擇年份"],
] as const)("calendar uses the library's %s strings", async (locale, previous, year) => {
  await loadLocale(locale);
  await render(<DateHarness locale={locale} />);
  await page.getByTestId("expiry").click();
  await expect.element(page.getByRole("button", { name: previous })).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: year })).toBeVisible();
});

test("English calendar keeps its English names", async () => {
  await render(<DateHarness />);
  await page.getByTestId("expiry").click();
  await expect
    .element(page.getByRole("button", { name: "Go to the Previous Month" }))
    .toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Choose the Year" })).toBeVisible();
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
  expect(describedBy.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
    shown,
  ]);
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

// Catches ids that collide or dangle when callers give the picker neither an id nor a test id.
test("generated ids link the trigger, the alert and the time group without a test id", async () => {
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
  await render(<Unlabelled />);
  const triggers = Array.from(document.querySelectorAll<HTMLElement>("button[aria-describedby]"));
  expect(triggers).toHaveLength(2);
  const ids = triggers.map((trigger) => trigger.getAttribute("aria-describedby") ?? "");
  expect(new Set(ids.flatMap((value) => value.split(" "))).size).toBe(4);
  const messages = ids.map((value) =>
    value.split(" ").map((id) => document.getElementById(id)?.textContent),
  );
  expect(messages[0]?.[1]).toBe("first error");
  expect(messages[1]?.[1]).toBe("second error");
  expect(document.querySelectorAll('[role="alert"][data-testid]')).toHaveLength(0);
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
    .poll(() => document.querySelectorAll('[data-slot="calendar"] select').length)
    .toBe(2);
  const day = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-slot="calendar-cell-trigger"]'),
  ).find((el) => el.textContent?.trim() === "1" && !el.closest('[data-outside="true"]'));
  if (!day) throw new Error("First day is missing");
  day.click();
  await expect.element(page.getByTestId("value")).toHaveTextContent("2026-06-01T13:45");
  await expect.element(page.getByTestId("expiry")).toMatchTextContent("Jun 1, 2026");
});
