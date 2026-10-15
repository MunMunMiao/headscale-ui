import "fake-indexeddb/auto";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n, setLocale } from "@/i18n";
import { englishCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";

beforeEach(async () => {
  await hydrateSettings();
  await setLocale("en-US");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = Date.parse("2027-03-01T12:00:00Z");
const DAY = 86_400_000;
// Dialog harness has no session or bridge timers, so only the wall clock is pinned.
function setNow(value: number) {
  vi.spyOn(Date, "now").mockReturnValue(value);
}

import CreateAuthKeyDialog from "./CreateAuthKeyDialog";
import type { AuthKeyDialogPayload } from "./create-auth-key-dialog";

const defaults = {
  user: "2",
  reusable: true,
  ephemeral: false,
  aclTags: "",
};
const labels = {
  title: "Create auth key",
  description: "Invite a machine",
  owner: "Owner",
  expiration: "Expiration",
  aclTags: "ACL tags",
  reusable: "Reusable",
  ephemeral: "Ephemeral",
  cancel: "Cancel",
  submit: "Create",
  time: "Time",
  hour: "Hour",
  minute: "Minute",
};
function Harness({
  empty = false,
  busy = false,
  error = "",
  expirationDays = undefined as number | undefined,
  owner = defaults.user,
}) {
  const [ownerDefaults] = useState({ ...defaults, user: owner });
  const [open, setOpen] = useState(true);
  const [paused, setPaused] = useState(false);
  const [users, setUsers] = useState(
    empty
      ? []
      : [
          { id: "1", label: "Alice" },
          { id: "2", label: "Bob" },
        ],
  );
  const [payload, setPayload] = useState<AuthKeyDialogPayload>();
  return (
    <I18nProvider i18n={i18n}>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <button
        type="button"
        data-testid="remove-owner"
        onClick={() => setUsers([{ id: "1", label: "Alice" }])}
      >
        Remove Bob
      </button>
      <button
        type="button"
        data-testid="switch-server"
        onClick={() => {
          setPaused(true);
          setUsers([{ id: "9", label: "Charlie from another server" }]);
        }}
      >
        Switch server
      </button>
      <CreateAuthKeyDialog
        open={open}
        paused={paused}
        onOpenChange={setOpen}
        users={users}
        defaults={ownerDefaults}
        expirationDays={expirationDays}
        labels={labels}
        isSubmitting={busy}
        error={error}
        onSubmit={setPayload}
      />
      <output data-testid="payload">{JSON.stringify(payload)}</output>
    </I18nProvider>
  );
}
// Catches lost controlled-field updates, user reconciliation overwriting tags, or incorrect local/UTC conversion.
test("submits edited key options while reconciling a removed owner without losing the draft", async () => {
  setNow(NOW);
  await setLocale("en-US");
  await render(<Harness />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await page.getByTestId("invite-tags").fill("tag:server,tag:prod");
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("invite-ephemeral").click();
  document.querySelector<HTMLButtonElement>('[data-testid="remove-owner"]')?.click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
  await expect.element(page.getByTestId("invite-tags")).toHaveValue("tag:server,tag:prod");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      user: "1",
      reusable: false,
      ephemeral: true,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: ["tag:server", "tag:prod"],
    }),
  );
});

test("freezes the open draft and owner options when its server session is replaced", async () => {
  await render(<Harness />);
  await page.getByTestId("invite-tags").fill("tag:original-server");
  await page.getByTestId("invite-reusable").click();
  document.querySelector<HTMLButtonElement>('[data-testid="switch-server"]')?.click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveTextContent("AliceBobNo owner (tags only)");
  await expect.element(page.getByTestId("invite-tags")).toHaveValue("tag:original-server");
  await expect.element(page.getByTestId("invite-reusable")).not.toBeChecked();
});

// Ignoring the owner change would issue the key for the default user instead.
test("issues a key for the explicitly chosen owner", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("1");
  await expect.element(page.getByTestId("invite-user")).toHaveValue("1");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      user: "1",
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: [],
    }),
  );
});
// Catches missing re-open reset and accidental loss of keyboard dismissal.
test("resets the form on reopening and allows Escape to close", async () => {
  await render(<Harness />);
  await page.getByTestId("invite-tags").fill("draft");
  await page.getByTestId("cancel-create-invite").click();
  await page.getByText("Reopen", { exact: true }).click();
  await expect.element(page.getByTestId("invite-tags")).toHaveValue("");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("invite-create-dialog")).not.toBeInTheDocument();
});
// Catches a regression to the old zero-user lock-out and lost inline error feedback.
test("keeps the form usable with no users and shows request errors", async () => {
  await render(<Harness empty error="Server refused key" />);
  await expect.element(page.getByTestId("invite-user")).toBeEnabled();
  await expect.element(page.getByTestId("create-invite")).toBeEnabled();
  await expect
    .element(page.getByTestId("create-invite-error"))
    .toHaveTextContent("Server refused key");
});

test("offers an explicit no-owner option after the users", async () => {
  await render(<Harness />);
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveTextContent("AliceBobNo owner (tags only)");
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
});

// Catches a stale or remembered owner: a tag-only key must always be a deliberate choice.
test("a tag-only submit works with zero users and omits the owner from the payload", async () => {
  setNow(NOW);
  await render(<Harness empty />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
  await page.getByTestId("invite-tags").fill("tag:server");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: ["tag:server"],
    }),
  );
  expect(document.querySelector('[data-testid="payload"]')?.textContent).not.toContain('"user"');
});

test("no owner and no tags does not submit, explains why and focuses the tags field", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .toHaveTextContent("A key without an owner needs at least one ACL tag.");
  await expect.element(page.getByTestId("invite-tags")).toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("invite-tags"))
    .toHaveAttribute("aria-describedby", "invite-tags-error invite-tags-hint");
  await expect.element(page.getByTestId("invite-tags-error")).toHaveAttribute("role", "alert");
  await expect.element(page.getByTestId("invite-tags")).toHaveFocus();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await page.getByTestId("invite-tags").fill("tag:fixed");
  await expect.element(page.getByTestId("invite-tags-error")).not.toBeInTheDocument();
  await expect.element(page.getByTestId("invite-tags")).not.toHaveAttribute("aria-invalid");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toMatchTextContent('"aclTags":["tag:fixed"]');
});

test("choosing an owner clears the tags-required error and submits as before", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-tags-error")).toBeInTheDocument();
  await page.getByTestId("invite-user").selectOptions("1");
  await expect.element(page.getByTestId("invite-tags-error")).not.toBeInTheDocument();
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      user: "1",
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: [],
    }),
  );
});

test("shows both errors together when the expiration is also invalid", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  setNow(NOW + 8 * DAY);
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-expiration-error")).toBeInTheDocument();
  await expect.element(page.getByTestId("invite-tags-error")).toBeInTheDocument();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  // The first invalid field in form order takes focus.
  await expect.element(page.getByTestId("invite-expiration")).toHaveFocus();
});

// Catches "server, db" reaching Headscale, which rejects tags without the prefix.
test("rejects tags without the tag: prefix, explains the format and focuses the field", async () => {
  setNow(NOW);
  await render(<Harness />);
  const tags = page.getByTestId("invite-tags");
  await expect.element(page.getByText(englishCopy.inviteTagsHint)).toBeVisible();
  await expect.element(tags).toHaveAttribute("aria-describedby", "invite-tags-hint");
  for (const value of ["server, db", "tag:server,tag:"]) {
    await tags.fill(value);
    await page.getByTestId("create-invite").click();
    await expect
      .element(page.getByTestId("invite-tags-error"))
      .toHaveTextContent(englishCopy.inviteTagsPrefix);
    await expect.element(tags).toHaveFocus();
    await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  }
  await tags.fill("tag:server, tag:db");
  await expect.element(page.getByTestId("invite-tags-error")).not.toBeInTheDocument();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:server","tag:db"]');
});

// Catches a remembered tag-only choice reopening with the first user while keeping its tags.
test("a no-owner default opens with no owner", async () => {
  await render(<Harness owner="" />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
});

// Catches a canceled no-owner choice leaking into the next open; a submitted one returns through defaults.
test("a no-owner choice is not remembered across opens", async () => {
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("cancel-create-invite").click();
  await page.getByText("Reopen", { exact: true }).click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
});

test("edited expiration time reaches the UTC key payload", async () => {
  setNow(NOW);
  const expected = new Date(NOW + 7 * DAY);
  expected.setHours(12, 5, 0, 0);
  await render(<Harness />);
  await page.getByTestId("invite-expiration").click();
  await page.getByTestId("invite-expiration-hour").selectOptions("12");
  await page.getByTestId("invite-expiration-minute").selectOptions("05");
  await userEvent.keyboard("{Escape}");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent(`"expiration":"${expected.toISOString()}"`);
});

// Catches a remembered absolute timestamp: every open must start from now plus the default days.
test("defaults the expiration to seven days from each open", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"expiration":"2027-03-08T12:00:00.000Z"');
  await page.getByTestId("cancel-create-invite").click();
  setNow(NOW + 30 * DAY);
  await page.getByText("Reopen", { exact: true }).click();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"expiration":"2027-04-07T12:00:00.000Z"');
});

test("an explicit expirationDays overrides the seven day default", async () => {
  setNow(NOW);
  await render(<Harness expirationDays={90} />);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"expiration":"2027-05-30T12:00:00.000Z"');
});

// Catches submitting an expiration that became past while the dialog sat open; Headscale would accept it.
test("rejects a stale expiration without sending and recovers once it is fixed", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-tags").fill("tag:draft");
  setNow(NOW + 8 * DAY);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toHaveTextContent("Choose an expiration in the future.");
  await expect
    .element(page.getByTestId("invite-expiration"))
    .toHaveAttribute("aria-invalid", "true");
  expect(
    page.getByTestId("invite-expiration").element().getAttribute("aria-describedby"),
  ).toContain("invite-expiration-error");
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect.element(page.getByTestId("invite-tags")).toHaveValue("tag:draft");
  await page.getByTestId("invite-expiration").click();
  await page.getByTestId("invite-expiration-minute").selectOptions("30");
  await expect.element(page.getByTestId("invite-expiration-error")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  setNow(NOW);
  const expected = new Date(NOW + 7 * DAY);
  expected.setMinutes(30, 0, 0);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent(`"expiration":"${expected.toISOString()}"`);
});

test("an explicit no-owner choice survives the owner list changing while open", async () => {
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  document.querySelector<HTMLButtonElement>('[data-testid="remove-owner"]')?.click();
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveTextContent("AliceNo owner (tags only)");
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
});

test("a submit in flight locks every control", async () => {
  await render(<Harness busy />);
  await expect.element(page.getByTestId("create-invite")).toBeDisabled();
  await expect.element(page.getByTestId("cancel-create-invite")).toBeDisabled();
  await expect.element(page.getByTestId("invite-tags")).toBeDisabled();
  expect(document.querySelector('[data-testid="create-invite"] .animate-spin')).not.toBeNull();
});
