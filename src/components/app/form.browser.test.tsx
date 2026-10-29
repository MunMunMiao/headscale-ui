import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useAppForm } from "./form";

interface Values {
  name: string;
  password: string;
  kind: string;
  accepted: boolean;
}

function Harness({
  save,
  defaults,
  busy,
}: {
  save: (value: Values) => Promise<void> | void;
  defaults?: Partial<Values>;
  busy?: boolean;
}) {
  const form = useAppForm({
    defaultValues: {
      name: "",
      password: "",
      kind: "",
      accepted: false,
      ...defaults,
    },
    onSubmit: async ({ value }) => save(value),
  });
  return (
    <form.AppForm>
      <form.Form data-testid="form">
        <form.AppField
          name="name"
          validators={{
            onDynamic: ({ value }) =>
              value.trim() ? undefined : "Name required",
          }}
        >
          {(field) => (
            <field.TextField
              id="name"
              label="Name"
              description="Public label"
            />
          )}
        </form.AppField>
        <form.AppField name="password">
          {(field) => (
            <field.TextField
              type="password"
              aria-label="Existing password"
              trimOnBlur={false}
            />
          )}
        </form.AppField>
        <form.AppField
          name="kind"
          validators={{
            onDynamic: ({ value }) =>
              value ? undefined : { message: "Kind required" },
          }}
        >
          {(field) => (
            <field.SelectField
              id="kind"
              label="Kind"
              aria-describedby="kind-help"
              errorId="kind-required"
            >
              <option value="">Choose</option>
              <option value="ready">Ready</option>
            </field.SelectField>
          )}
        </form.AppField>
        <p id="kind-help">Choose a kind.</p>
        <form.AppField
          name="accepted"
          validators={{
            onDynamic: ({ value }) =>
              value ? undefined : "Confirmation required",
          }}
        >
          {(field) => <field.CheckboxField id="accepted" label="Confirm" />}
        </form.AppField>
        <form.SubmitButton busy={busy}>Save</form.SubmitButton>
      </form.Form>
    </form.AppForm>
  );
}

test("normalizes editable text on blur without destroying a legacy password proof", async () => {
  const saved: Values[] = [];
  await render(
    <Harness
      save={(value) => {
        saved.push(value);
      }}
    />,
  );
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("  Team A  ");
  await page.getByLabelText("Existing password").fill(" old password ");
  await page.getByRole("combobox", { name: "Kind" }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toHaveValue("Team A");
  await expect
    .element(page.getByLabelText("Existing password"))
    .toHaveValue(" old password ");
  expect(saved).toEqual([]);
});

test("form selects keep touch-safe text at narrow widths", async () => {
  await page.viewport(360, 640);
  try {
    await render(<Harness save={() => {}} />);
    expect(
      getComputedStyle(page.getByRole("combobox", { name: "Kind" }).element())
        .fontSize,
    ).toBe("16px");
  } finally {
    await page.viewport(1280, 720);
  }
});

test("only describes fields with elements that exist", async () => {
  await render(<Harness save={() => {}} />);
  for (const element of document.querySelectorAll("[aria-describedby]")) {
    for (const id of element.getAttribute("aria-describedby")?.split(/\s+/) ??
      []) {
      expect(
        document.getElementById(id),
        `${element.getAttribute("name")} references ${id}`,
      ).not.toBeNull();
    }
  }
});

function ExternalLabels() {
  const form = useAppForm({
    defaultValues: { kind: "ready", accepted: false },
  });
  return (
    <form.AppForm>
      <form.AppField name="kind">
        {(field) => (
          <field.SelectField aria-label="Kind">
            <option value="ready">Ready</option>
            <option value="paused">Paused</option>
          </field.SelectField>
        )}
      </form.AppField>
      <span id="acceptance-label">Accept changes</span>
      <form.AppField name="accepted">
        {(field) => <field.CheckboxField aria-labelledby="acceptance-label" />}
      </form.AppField>
    </form.AppForm>
  );
}

test("supports accessible names supplied outside select and checkbox controls", async () => {
  await render(<ExternalLabels />);
  await page.getByRole("combobox", { name: "Kind" }).selectOptions("paused");
  await expect
    .element(page.getByRole("combobox", { name: "Kind" }))
    .toHaveValue("paused");
  await page.getByRole("checkbox", { name: "Accept changes" }).click();
  await expect
    .element(page.getByRole("checkbox", { name: "Accept changes" }))
    .toBeChecked();
});

test("shows field errors on submit, focuses the first error and revalidates corrections", async () => {
  const saved: Values[] = [];
  await render(
    <Harness
      save={(value) => {
        saved.push(value);
      }}
    />,
  );
  for (const message of [
    "Name required",
    "Kind required",
    "Confirmation required",
  ])
    await expect
      .element(page.getByText(message, { exact: true }))
      .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByText("Name required", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByTestId("kind-required"))
    .toHaveTextContent("Kind required");
  await expect
    .element(page.getByRole("combobox", { name: "Kind" }))
    .toHaveAttribute("aria-describedby", "kind-help kind-required");
  await expect
    .element(page.getByText("Confirmation required", { exact: true }))
    .toBeVisible();
  for (const element of document.querySelectorAll("[aria-describedby]")) {
    for (const id of element.getAttribute("aria-describedby")?.split(/\s+/) ??
      []) {
      expect(
        document.querySelectorAll(`[id="${CSS.escape(id)}"]`),
      ).toHaveLength(1);
    }
  }
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .toHaveFocus();
  expect(saved).toEqual([]);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Team A");
  await page.getByRole("combobox", { name: "Kind" }).selectOptions("ready");
  await page.getByRole("checkbox", { name: "Confirm", exact: true }).click();
  for (const message of [
    "Name required",
    "Kind required",
    "Confirmation required",
  ])
    await expect
      .element(page.getByText(message, { exact: true }))
      .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => saved)
    .toEqual([{ name: "Team A", password: "", kind: "ready", accepted: true }]);
});

test("reflects an external pending operation in the submit button", async () => {
  const saved: Values[] = [];
  const save = (value: Values) => {
    saved.push(value);
  };
  const view = await render(<Harness save={save} busy />);
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toHaveAttribute("aria-busy", "true");
  expect(saved).toEqual([]);
  await view.rerender(<Harness save={save} busy={false} />);
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toHaveAttribute("aria-busy", "false");
});

test("blocks duplicate submissions and freezes fields until the async save completes", async () => {
  const pending = Promise.withResolvers<void>();
  const saved: Values[] = [];
  await render(
    <Harness
      defaults={{ name: "Alpha", kind: "ready", accepted: true }}
      save={async (value) => {
        saved.push(value);
        await pending.promise;
      }}
    />,
  );
  const form = page.getByTestId("form").element();
  expect.assert(form instanceof HTMLFormElement);
  try {
    form.requestSubmit();
    form.requestSubmit();
    await expect.poll(() => saved.length).toBe(1);
    await expect
      .element(page.getByRole("button", { name: "Save", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Save", exact: true }))
      .toHaveAttribute("aria-busy", "true");
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .toHaveAttribute("readonly");
    await expect
      .element(page.getByRole("combobox", { name: "Kind" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("checkbox", { name: "Confirm", exact: true }))
      .toBeDisabled();
  } finally {
    pending.resolve();
  }
  await expect
    .element(page.getByRole("button", { name: "Save", exact: true }))
    .toBeEnabled();
  await expect
    .element(page.getByRole("textbox", { name: "Name", exact: true }))
    .not.toHaveAttribute("readonly");
  await page.getByRole("textbox", { name: "Name", exact: true }).click();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => saved.length).toBe(2);
});
