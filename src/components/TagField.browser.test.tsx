import "fake-indexeddb/auto";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { i18n, setLocale } from "@/i18n";
import { getProductCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import { TagField } from "./TagField";

beforeEach(async () => {
  await hydrateSettings();
});
afterEach(async () => {
  await cleanup();
  document.documentElement.dir = "ltr";
  document.documentElement.classList.remove("dark");
  document.documentElement.style.zoom = "";
  await page.viewport(1366, 900);
});
function Host({
  mode = "key",
  tags = [] as string[],
  options = [] as string[],
  manage = false,
  disabled,
}: {
  mode?: "device" | "key";
  tags?: string[];
  options?: string[];
  manage?: boolean;
  disabled?: boolean;
}) {
  const [managed, setManaged] = useState("");
  const [value, setValue] = useState(tags);
  const [submitted, setSubmitted] = useState(0);
  return (
    <I18nProvider i18n={i18n}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(submitted + 1);
        }}
      >
        <TagField
          id="test-tags"
          mode={mode}
          value={value}
          onChange={setValue}
          options={options}
          declaredTags={options}
          disabled={disabled}
          onManage={manage ? (tag) => setManaged(tag ?? "general") : undefined}
        />
        <output data-testid="managed">{managed}</output>
        <output data-testid="selected" className="break-all">
          {JSON.stringify(value)}
        </output>
        <output data-testid="submitted">{submitted}</output>
        <button type="submit">Submit</button>
      </form>
    </I18nProvider>
  );
}

test("unified feedback: the named removal control exposes short keyboard help without hiding tag warnings", async () => {
  await setLocale("en-US");
  await render(
    <Host mode="device" tags={["tag:legacy"]} options={[]} manage />,
  );
  const remove = page.getByTestId("test-tags-remove-tag:legacy");
  for (
    let step = 0;
    step < 20 && document.activeElement !== remove.element();
    ++step
  )
    await userEvent.tab();
  await expect.element(remove).toHaveFocus();
  await expect
    .element(page.getByText("Remove tag:legacy", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText(getProductCopy("en-US").tagUndeclared, { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByText(getProductCopy("en-US").tagReadbackHint, { exact: true }),
    )
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByText("Remove tag:legacy", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(remove).toHaveFocus();
  expect(remove.element().querySelector("button")).toBeNull();
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:legacy"]');
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
});

test("unified feedback: a field read error remains linked, visible and recoverable", async () => {
  await setLocale("en-US");
  let retries = 0;
  await render(
    <I18nProvider i18n={i18n}>
      <p id="external-description">Keep the complete selected tag set.</p>
      <TagField
        id="failed-tags"
        mode="device"
        value={["tag:legacy"]}
        onChange={() => {}}
        options={[]}
        declaredTags={null}
        error="Read the policy before selecting a new tag."
        aria-describedby="external-description"
        onRetry={() => {
          ++retries;
        }}
      />
    </I18nProvider>,
  );
  const input = page.getByTestId("failed-tags-search");
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(input)
    .toHaveAccessibleDescription(
      `Keep the complete selected tag set. Read the policy before selecting a new tag. ${getProductCopy("en-US").tagReadbackHint}`,
    );
  await expect.element(page.getByTestId("failed-tags-error")).toBeVisible();
  await page.getByTestId("failed-tags-retry").click();
  expect(retries).toBe(1);
  await expect
    .element(page.getByTestId("failed-tags-remove-tag:legacy"))
    .toBeVisible();
});

test("empty key suggestions never require a definition and legal tag:1abc needs an explicit add", async () => {
  await setLocale("en-US");
  await render(<Host />);
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .not.toHaveTextContent(getProductCopy("en-US").tagNoOptions);
  await page.getByTestId("test-tags-search").fill("tag:1abc");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("selected")).toHaveTextContent("[]");
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
  await page.getByTestId("test-tags-add").click();
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:1abc"]');
  await page.getByTestId("test-tags-search").fill("tag:Web1");
  await expect.element(page.getByTestId("test-tags-add")).toBeDisabled();
});

test("device search retains abnormal selected values and only explicitly removes the named value", async () => {
  await setLocale("en-US");
  await render(
    <Host
      mode="device"
      tags={["tag:legacy", "tag:Web1", "tag:1abc"]}
      options={["tag:prod", "tag:Web1"]}
    />,
  );
  await page.getByTestId("test-tags-search").fill("prod");
  await expect
    .element(page.getByTestId("test-tags-remove-tag:legacy"))
    .toHaveAccessibleName("Remove tag:legacy");
  await expect
    .element(page.getByTestId("test-tags-remove-tag:Web1"))
    .toBeVisible();
  await page.getByTestId("test-tags-option-tag:prod").click();
  await page.getByTestId("test-tags-remove-tag:legacy").click();
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:Web1","tag:1abc","tag:prod"]');
  expect(
    document.querySelector('[data-testid="test-tags-option-tag:Web1"]'),
  ).toBeNull();
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
});

test("empty device candidates and unmatched search have distinct statuses and recovery controls", async () => {
  await setLocale("en-US");
  await render(<Host mode="device" tags={["tag:legacy"]} manage />);
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .toHaveTextContent(getProductCopy("en-US").tagNoOptions);
  await expect.element(page.getByTestId("test-tags-manage")).toBeEnabled();
  await page.getByTestId("test-tags-search").fill("missing candidate");
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .toHaveTextContent(getProductCopy("en-US").tagNoMatches);
  await expect
    .element(page.getByTestId("test-tags-remove-tag:legacy"))
    .toBeVisible();
  await page.getByTestId("test-tags-clear").click();
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .toHaveTextContent(getProductCopy("en-US").tagNoOptions);
  await page.getByTestId("test-tags-manage").click();
  await expect
    .element(page.getByTestId("managed"))
    .toHaveTextContent("general");
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:legacy"]');
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
});

test("usability: selecting every compatible tag does not claim definitions are missing", async () => {
  await setLocale("en-US");
  await render(<Host mode="device" options={["tag:prod", "tag:extra"]} />);
  await page.getByTestId("test-tags-option-tag:prod").click();
  await page.getByTestId("test-tags-option-tag:extra").click();
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .not.toHaveTextContent(getProductCopy("en-US").tagNoOptions);
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .toHaveTextContent("All compatible tags are already selected.");
  await page.getByTestId("test-tags-remove-tag:prod").click();
  await expect
    .element(page.getByTestId("test-tags-option-tag:prod"))
    .toBeVisible();
  await expect
    .element(page.getByTestId("test-tags-empty"))
    .not.toBeInTheDocument();
});

test("disabled native controls cannot mutate the selected collection", async () => {
  await setLocale("en-US");
  await render(<Host tags={["tag:prod"]} options={["tag:extra"]} disabled />);
  const remove = page.getByTestId("test-tags-remove-tag:prod");
  const add = page.getByTestId("test-tags-option-tag:extra");
  await expect.element(remove).toBeDisabled();
  await expect.element(add).toBeDisabled();
  (remove.element() as HTMLButtonElement).click();
  (add.element() as HTMLButtonElement).click();
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:prod"]');
});

test("defining an undeclared selection hands off its exact name without changing the selection", async () => {
  await setLocale("en-US");
  await render(<Host tags={["tag:missing", "tag:1abc"]} manage />);
  await page.getByTestId("test-tags-define-tag:missing").click();
  await expect
    .element(page.getByTestId("managed"))
    .toHaveTextContent("tag:missing");
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:missing","tag:1abc"]');
  expect(
    document.querySelector('[data-testid="test-tags-define-tag:1abc"]'),
  ).toBeNull();
  await page.getByTestId("test-tags-manage").click();
  await expect
    .element(page.getByTestId("managed"))
    .toHaveTextContent("general");
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
});

test.each([false, true])(
  "long selections and keyboard controls fit the 320px RTL %s dark theme",
  async (dark) => {
    await setLocale("ar");
    await page.viewport(320, 640);
    document.documentElement.dir = "rtl";
    document.documentElement.classList.toggle("dark", dark);
    const tag = `tag:${"long-network-identity-".repeat(8)}`;
    await render(<Host tags={[tag, "tag:other"]} manage />);
    for (const id of [
      "test-tags-search",
      `test-tags-remove-${tag}`,
      "test-tags-manage",
    ]) {
      const bounds = page.getByTestId(id).element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(320);
    }
    (
      page.getByTestId(`test-tags-remove-${tag}`).element() as HTMLButtonElement
    ).focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId("selected"))
      .toHaveTextContent('["tag:other"]');
    await page.getByTestId("test-tags-search").fill("tag:keyboard");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
    await userEvent.tab();
    await expect.element(page.getByTestId("test-tags-clear")).toHaveFocus();
    await userEvent.tab();
    await expect.element(page.getByTestId("test-tags-add")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByTestId("test-tags-remove-tag:keyboard"))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  },
);

test("the selected list and named removal remain keyboard reachable at 320px in RTL", async () => {
  await setLocale("en-US");
  await page.viewport(320, 640);
  document.documentElement.dir = "rtl";
  await render(<Host tags={["tag:legacy-with-a-long-name"]} />);
  await page
    .getByTestId("test-tags-remove-tag:legacy-with-a-long-name")
    .click();
  await page.getByTestId("test-tags-search").fill("tag:prod");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("submitted")).toHaveTextContent("0");
  await page.getByTestId("test-tags-add").click();
  await expect
    .element(page.getByTestId("selected"))
    .toHaveTextContent('["tag:prod"]');
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});
