import "fake-indexeddb/auto";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { i18n, setLocale } from "@/i18n";
import { englishCopy } from "@/i18n/product-copy";
import { hydrateSettings } from "@/lib/settings-storage";
import CreateAuthKeyDialog from "./CreateAuthKeyDialog";
import type {
  AuthKeyDialogDraft,
  AuthKeyDialogPayload,
} from "./create-auth-key-dialog";

beforeEach(async () => {
  await hydrateSettings();
  await setLocale("en-US");
});
afterEach(() => vi.restoreAllMocks());
const NOW = Date.parse("2027-03-01T12:00:00Z");
const DAY = 86_400_000;
function setNow(value: number) {
  vi.spyOn(Date, "now").mockReturnValue(value);
}
const defaults = { user: "2", reusable: true, ephemeral: false, aclTags: "" };
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
  tags = "",
  management = true,
  restoredDraft = undefined as AuthKeyDialogDraft | undefined,
  submit = undefined as
    ((payload: AuthKeyDialogPayload) => void | Promise<void>) | undefined,
}) {
  const [ownerDefaults] = useState({
    ...defaults,
    user: empty ? "" : owner,
    aclTags: tags,
  });
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
  const [managed, setManaged] = useState<AuthKeyDialogDraft>();
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
        data-testid="refresh-owners"
        onClick={() => setUsers((current) => [...current])}
      >
        Refresh owners
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
        restoredDraft={restoredDraft}
        tagOptions={management ? ["tag:server"] : undefined}
        declaredTags={management ? ["tag:server"] : undefined}
        labels={labels}
        isSubmitting={busy}
        error={error}
        onManageTags={
          management
            ? (value) => {
                setManaged(value);
                setOpen(false);
              }
            : undefined
        }
        onSubmit={(value) => {
          setPayload(value);
          return submit?.(value);
        }}
      />
      <output data-testid="payload">{JSON.stringify(payload)}</output>
      <output data-testid="managed">{JSON.stringify(managed)}</output>
    </I18nProvider>
  );
}
async function addTags(...tags: string[]) {
  for (const tag of tags) {
    await page.getByTestId("invite-tags-search").fill(tag);
    await page.getByTestId("invite-tags-add").click();
  }
}
function selected() {
  return page.getByTestId("invite-tags-selected");
}

test("free tag creation does not require suggestions or a management callback", async () => {
  setNow(NOW);
  await render(<Harness management={false} />);
  await expect
    .element(page.getByTestId("invite-tags-manage"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-tags-options"))
    .toHaveTextContent("");
  await addTags("tag:1abc");
  await page.getByTestId("create-invite").click();
  expect(
    JSON.parse(page.getByTestId("payload").element().textContent ?? "null"),
  ).toMatchObject({
    user: "2",
    aclTags: ["tag:1abc"],
  });
});

// A vanished selection is retained and blocks creation until the operator explicitly chooses again.
test("does not silently replace a removed creation-associated user", async () => {
  setNow(NOW);
  await render(<Harness />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await addTags("tag:server", "tag:prod");
  await page.getByTestId("invite-reusable").click();
  await page.getByTestId("invite-ephemeral").click();
  document
    .querySelector<HTMLButtonElement>('[data-testid="remove-owner"]')
    ?.click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await expect.element(selected()).toMatchTextContent("tag:prod");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect.element(page.getByTestId("invite-user-error")).toBeVisible();
  await page.getByTestId("invite-user").selectOptions("1");
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

test("a restored missing user without a saved label retains the ID until explicitly changed", async () => {
  setNow(NOW);
  await render(
    <Harness
      restoredDraft={{
        userId: "missing-user",
        userName: "",
        reusable: false,
        ephemeral: false,
        tags: ["tag:server"],
        tagInput: "",
        expiration: "2027-03-02T12:00:00Z",
        expirationMode: "custom",
        expiryDays: "7",
      }}
    />,
  );
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveValue("missing-user");
  expect(page.getByTestId("invite-user").element().textContent).toContain(
    "missing-user",
  );
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-user-error")).toBeVisible();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
});

test("a deliberately unowned tagged invitation keeps an empty creation-associated identity in its return draft", async () => {
  setNow(NOW);
  await render(<Harness />);
  await addTags("tag:server");
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("invite-tags-manage").click();
  expect(
    JSON.parse(page.getByTestId("managed").element().textContent ?? "null"),
  ).toMatchObject({
    userId: "",
    userName: "",
    tags: ["tag:server"],
  });
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
});

test("restores the exact absolute expiry instead of restarting the default duration", async () => {
  setNow(NOW);
  await render(
    <Harness
      restoredDraft={{
        userId: "1",
        userName: "Alice",
        reusable: false,
        ephemeral: true,
        tags: ["tag:1abc"],
        tagInput: "not-yet-selected",
        expiration: "2027-03-02T12:34:56.789Z",
        expirationMode: "custom",
        expiryDays: "7",
      }}
    />,
  );
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      user: "1",
      reusable: false,
      ephemeral: true,
      expiration: "2027-03-02T12:34:56.789Z",
      aclTags: ["tag:1abc"],
    }),
  );
});

test("an expired restored absolute expiry requires correction without extending it", async () => {
  setNow(NOW);
  await render(
    <Harness
      restoredDraft={{
        userId: "1",
        userName: "Alice",
        reusable: false,
        ephemeral: true,
        tags: ["tag:server"],
        tagInput: "",
        expiration: "2027-02-28T12:00:00.000Z",
        expirationMode: "custom",
        expiryDays: "7",
      }}
    />,
  );
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toBeVisible();
});

test("explicit free-add accepts undeclared digit-first tags while search never submits", async () => {
  setNow(NOW);
  await render(<Harness owner="" />);
  await page.getByTestId("invite-tags-search").fill("tag:1abc");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await page.getByTestId("invite-tags-add").click();
  await page.getByTestId("invite-tags-search").fill("tag:Web1");
  await expect.element(page.getByTestId("invite-tags-add")).toBeDisabled();
  await expect.element(selected()).toMatchTextContent("tag:1abc");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:1abc"]');
});

test("keeps untouched owner and expiration defaults when the caller refreshes its user options", async () => {
  setNow(NOW);
  await render(<Harness />);
  document
    .querySelector<HTMLButtonElement>('[data-testid="refresh-owners"]')
    ?.click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      user: "2",
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: [],
    }),
  );
});

test("freezes the open draft and owner options when its server session is replaced", async () => {
  await render(<Harness />);
  await addTags("tag:original-server");
  await page.getByTestId("invite-tags-search").fill("uncommitted search");
  await page.getByTestId("invite-reusable").click();
  document
    .querySelector<HTMLButtonElement>('[data-testid="switch-server"]')
    ?.click();
  await expect.element(page.getByTestId("invite-user")).toHaveValue("2");
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveTextContent("AliceBobNo owner (tags only)");
  await expect.element(selected()).toMatchTextContent("tag:original-server");
  await expect
    .element(page.getByTestId("invite-tags-search"))
    .toHaveValue("uncommitted search");
  await expect.element(page.getByTestId("invite-reusable")).not.toBeChecked();
});

test.each(["Cancel", "Escape"])(
  "can leave a paused draft through %s without submitting",
  async (action) => {
    await render(<Harness />);
    await addTags("tag:original-server");
    document
      .querySelector<HTMLButtonElement>('[data-testid="switch-server"]')
      ?.click();
    await expect.element(page.getByTestId("create-invite")).toBeDisabled();
    if (action === "Cancel") {
      await expect
        .element(page.getByTestId("cancel-create-invite"))
        .toBeEnabled();
      await page.getByTestId("cancel-create-invite").click();
    } else await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .not.toBeInTheDocument();
    await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  },
);

test("issues a key for the explicitly chosen owner", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("1");
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

test("resets the form on reopening and allows Escape to close", async () => {
  await render(<Harness />);
  await addTags("tag:draft");
  await page.getByTestId("invite-tags-search").fill("unfinished");
  await page.getByTestId("cancel-create-invite").click();
  await page.getByText("Reopen", { exact: true }).click();
  await expect.element(page.getByTestId("invite-tags-search")).toHaveValue("");
  await expect.element(selected()).not.toMatchTextContent("tag:draft");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByTestId("invite-create-dialog"))
    .not.toBeInTheDocument();
});

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

test("a tag-only submit works with zero users and omits the owner from the payload", async () => {
  setNow(NOW);
  await render(<Harness empty />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
  await addTags("tag:server");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("payload")).toHaveTextContent(
    JSON.stringify({
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: ["tag:server"],
    }),
  );
  expect(page.getByTestId("payload").element().textContent).not.toContain(
    '"user"',
  );
});

test("no owner and no tags does not submit, explains why and focuses the tags field", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .toHaveTextContent(englishCopy.inviteTagsRequired);
  await expect
    .element(page.getByTestId("invite-tags-search"))
    .toHaveAttribute("aria-invalid", "true");
  await expect
    .element(page.getByTestId("invite-tags-search"))
    .toHaveAttribute("aria-describedby", "invite-tags-error invite-tags-hint");
  await expect.element(page.getByTestId("invite-tags-search")).toHaveFocus();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await addTags("tag:fixed");
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByTestId("invite-tags-search"))
    .not.toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:fixed"]');
});

test("choosing an owner clears the tags-required error and submits as before", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  await page.getByTestId("create-invite").click();
  await expect.element(page.getByTestId("invite-tags-error")).toBeVisible();
  await page.getByTestId("invite-user").selectOptions("1");
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .not.toBeInTheDocument();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"user":"1"');
});

test("shows both errors together when the expiration is also invalid", async () => {
  setNow(NOW);
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  setNow(NOW + 8 * DAY);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toBeVisible();
  await expect.element(page.getByTestId("invite-tags-error")).toBeVisible();
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect.element(page.getByTestId("invite-expiration")).toHaveFocus();
});

test("invalid free-add names cannot become selected tags or submit the host form", async () => {
  setNow(NOW);
  await render(<Harness owner="" />);
  for (const value of ["server", "tag:", "tag:Web1", "tag:server tag:db"]) {
    await page.getByTestId("invite-tags-search").fill(value);
    await expect.element(page.getByTestId("invite-tags-add")).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  }
  await addTags("tag:server", "tag:db");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:server","tag:db"]');
});

test("retains an incompatible restored tag and blocks submission until explicitly removed", async () => {
  setNow(NOW);
  await render(<Harness tags="tag:Web1" />);
  await expect.element(selected()).toMatchTextContent("tag:Web1");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-tags-error"))
    .toHaveTextContent(englishCopy.inviteTagsPrefix);
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await page.getByTestId("invite-tags-remove-tag:Web1").click();
  await addTags("tag:server");
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:server"]');
});

test("tagged keys describe their user as creator rather than node owner", async () => {
  await render(<Harness />);
  await addTags("tag:server");
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveAttribute("aria-describedby", "invite-owner-hint");
  await expect
    .element(page.getByTestId("invite-owner-hint"))
    .toMatchTextContent("creator, not the owner");
  await page.getByTestId("invite-tags-remove-tag:server").click();
  await expect
    .element(page.getByTestId("invite-owner-hint"))
    .not.toBeInTheDocument();
});

test("a no-owner default opens with no owner", async () => {
  await render(<Harness owner="" />);
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
});
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

test("rejects a stale expiration without sending and recovers once it is fixed", async () => {
  setNow(NOW);
  await render(<Harness />);
  await addTags("tag:draft");
  setNow(NOW + 8 * DAY);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toHaveTextContent("Choose an expiration in the future.");
  await expect
    .element(page.getByTestId("invite-expiration"))
    .toHaveAttribute("aria-invalid", "true");
  expect(
    page
      .getByTestId("invite-expiration")
      .element()
      .getAttribute("aria-describedby"),
  ).toContain("invite-expiration-error");
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect.element(selected()).toMatchTextContent("tag:draft");
  await page.getByTestId("invite-expiration").click();
  await page.getByTestId("invite-expiration-minute").selectOptions("30");
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .toBeVisible();
  await expect.element(page.getByTestId("create-invite")).toBeDisabled();
  setNow(NOW);
  await page.getByTestId("invite-expiration-minute").selectOptions("31");
  await expect
    .element(page.getByTestId("invite-expiration-error"))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  const expected = new Date(NOW + 7 * DAY);
  expected.setMinutes(31, 0, 0);
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent(`"expiration":"${expected.toISOString()}"`);
});

test("an explicit no-owner choice survives the owner list changing while open", async () => {
  await render(<Harness />);
  await page.getByTestId("invite-user").selectOptions("");
  document
    .querySelector<HTMLButtonElement>('[data-testid="remove-owner"]')
    ?.click();
  await expect
    .element(page.getByTestId("invite-user"))
    .toHaveTextContent("AliceNo owner (tags only)");
  await expect.element(page.getByTestId("invite-user")).toHaveValue("");
});
test("a submit in flight locks every control", async () => {
  await render(<Harness busy />);
  await expect.element(page.getByTestId("create-invite")).toBeDisabled();
  await expect
    .element(page.getByTestId("create-invite"))
    .toHaveAttribute("aria-busy", "true");
  await expect.element(page.getByTestId("cancel-create-invite")).toBeDisabled();
  await expect.element(page.getByTestId("invite-tags-search")).toBeDisabled();
  await expect.element(page.getByTestId("invite-expiration")).toBeDisabled();
  expect(
    document.querySelector('[data-testid="create-invite"] .animate-spin'),
  ).not.toBeNull();
});

test("explicit add trims a free tag while Enter only searches and preserves the selected list", async () => {
  setNow(NOW);
  await render(<Harness />);
  await addTags("  tag:server  ");
  await page.getByTestId("invite-tags-search").fill("tag:db");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  await expect.element(selected()).toMatchTextContent("tag:server");
  await expect.element(selected()).not.toMatchTextContent("tag:db");
  await page.getByTestId("invite-tags-add").click();
  await page.getByTestId("create-invite").click();
  await expect
    .element(page.getByTestId("payload"))
    .toMatchTextContent('"aclTags":["tag:server","tag:db"]');
});

test("a native management click in the same turn as submission cannot leave the pending form", async () => {
  const request = Promise.withResolvers<void>();
  const submit = vi.fn(() => request.promise);
  await render(<Harness submit={submit} />);
  const form = page.getByTestId("invite-form").element();
  const manage = page
    .getByTestId("invite-tags-manage")
    .element() as HTMLButtonElement;
  form.dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
  manage.click();
  try {
    await expect.poll(() => submit.mock.calls.length).toBe(1);
    await expect.element(page.getByTestId("managed")).toHaveTextContent("");
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
  } finally {
    request.resolve();
  }
});

test("awaits async creation, blocks duplicate submits and keeps the dialog open while pending", async () => {
  const request = Promise.withResolvers<void>();
  const submit = vi.fn(() => request.promise);
  await render(<Harness submit={submit} />);
  const form = page.getByTestId("invite-form").element();
  form.dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
  form.dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true }),
  );
  try {
    await expect.poll(() => submit.mock.calls.length).toBe(1);
    await expect
      .element(page.getByTestId("create-invite"))
      .toHaveAttribute("aria-busy", "true");
    for (const field of [
      "user",
      "expiration",
      "tags-search",
      "reusable",
      "ephemeral",
    ])
      await expect.element(page.getByTestId(`invite-${field}`)).toBeDisabled();
    await expect
      .element(page.getByTestId("cancel-create-invite"))
      .toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByTestId("invite-create-dialog"))
      .toBeVisible();
  } finally {
    request.resolve();
  }
  await expect.element(page.getByTestId("create-invite")).toBeEnabled();
  await page.getByTestId("create-invite").click();
  await expect.poll(() => submit.mock.calls.length).toBe(2);
});

test.each(["busy", "paused"])(
  "does not bypass the %s guard through a native form submit",
  async (guard) => {
    const submit = vi.fn();
    await render(<Harness busy={guard === "busy"} submit={submit} />);
    if (guard === "paused")
      document
        .querySelector<HTMLButtonElement>('[data-testid="switch-server"]')
        ?.click();
    await expect.element(page.getByTestId("create-invite")).toBeDisabled();
    page
      .getByTestId("invite-form")
      .element()
      .dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(submit).not.toHaveBeenCalled();
    await expect.element(page.getByTestId("payload")).toHaveTextContent("");
  },
);

test("management captures the unblurred search and every selected option without submitting", async () => {
  setNow(NOW);
  await render(<Harness />);
  await addTags("tag:1abc");
  await page.getByTestId("invite-tags-search").fill("unfinished search");
  await page.getByTestId("invite-tags-manage").click();
  await expect
    .element(page.getByTestId("managed"))
    .toMatchTextContent('"tagInput":"unfinished search"');
  await expect
    .element(page.getByTestId("managed"))
    .toMatchTextContent('"expiration":"2027-03-08T12:00:00.000Z"');
  await expect
    .element(page.getByTestId("managed"))
    .toMatchTextContent('"tags":["tag:1abc"]');
  await expect.element(page.getByTestId("payload")).toHaveTextContent("");
});
