import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { setLocale } from "@/i18n";
import { prepareTestSession, renderSessionPage } from "@/test/session";
import LoginPage from "./LoginPage";

async function openNewConnection() {
  await page.viewport(1366, 900);
  const requests: string[] = [];
  const session = await prepareTestSession(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(new URL(request.url).pathname);
    return new Response(null, { status: 401 });
  });
  await setLocale("en-US");
  await renderSessionPage(session, <LoginPage />, "/login");
  await page.getByTestId("profile-option-new").click();
  return { session, requests };
}

test.each([
  ["connect-profile-name", "  Team A\t ", "Team A"],
  [
    "connect-server-url",
    "  https://fixture.invalid/path/  ",
    "https://fixture.invalid/path/",
  ],
  ["connect-api-key", "  isolated-key  ", "isolated-key"],
  ["connect-password", "  server password  ", "server password"],
  ["connect-password-confirm", "  server password  ", "server password"],
])(
  "normalizes %s on blur without probing or saving the server",
  async (id, value, expected) => {
    const { session, requests } = await openNewConnection();
    await page.getByTestId(id).fill(value);
    await page
      .getByTestId(
        id === "connect-profile-name"
          ? "connect-server-url"
          : "connect-profile-name",
      )
      .click();
    await expect.element(page.getByTestId(id)).toHaveValue(expected);
    expect(requests).toEqual([]);
    expect(session.profiles.getSnapshot().profiles).toEqual([]);
  },
);

test("API key help opens separately and returns focus without consuming the connection draft", async () => {
  const { session, requests } = await openNewConnection();
  await page.getByTestId("connect-profile-name").fill("Draft server");
  await page.getByTestId("connect-api-key").fill("isolated-key");
  await page.getByTestId("connect-password").fill("server password");
  await expect
    .element(page.getByTestId("api-key-command-copy"))
    .not.toBeInTheDocument();

  const help = page.getByRole("button", {
    name: "How to get an API key",
    exact: true,
  });
  await help.click();
  const dialog = page.getByRole("dialog", {
    name: "How to get an API key",
    exact: true,
  });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog)
    .toMatchTextContent("headscale apikeys create --expiration 90d");
  await expect.element(page.getByTestId("api-key-command-copy")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(help).toHaveFocus();
  await expect.element(page.getByTestId("connection-dialog")).toBeVisible();
  await expect
    .element(page.getByTestId("connect-profile-name"))
    .toHaveValue("Draft server");
  await expect
    .element(page.getByTestId("connect-api-key"))
    .toHaveValue("isolated-key");
  await expect
    .element(page.getByTestId("connect-password"))
    .toHaveValue("server password");
  expect(requests).toEqual([]);
  expect(session.profiles.getSnapshot().profiles).toEqual([]);
});
