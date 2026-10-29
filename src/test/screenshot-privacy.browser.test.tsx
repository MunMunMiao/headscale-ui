import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

test("browser evidence conceals credential glyphs without changing values or controls", async () => {
  const view = await render(
    <div>
      <p>Credential result</p>
      <input
        data-secret-fixture
        type="password"
        defaultValue="fixture-password"
      />
      <input
        data-secret-fixture
        id="connect-api-key"
        defaultValue="fixture-api-key"
      />
      <input
        data-secret-fixture
        autoComplete="new-password"
        defaultValue="fixture-new-password"
      />
      <input
        data-secret-fixture
        id="pending-node-key"
        defaultValue="fixture-registration-key"
      />
      <fieldset data-testid="created-api-key">
        <code data-secret-fixture className="text-foreground">
          fixture-created-api-key
        </code>
      </fieldset>
      <fieldset data-testid="created-invite">
        <code data-secret-fixture>fixture-created-auth-key</code>
        <code data-secret-fixture>
          tailscale up --auth-key=fixture-created-auth-key
        </code>
      </fieldset>
      <div data-testid="invite-table">
        <code data-secret-fixture>fixture-listed-key</code>
      </div>
      <code data-secret-fixture data-testid="invite-action-key">
        fixture-confirmation-key
      </code>
      <button type="button">Copy</button>
    </div>,
  );
  try {
    const credentials = document.querySelectorAll<HTMLElement>(
      "[data-secret-fixture]",
    );
    expect(credentials).toHaveLength(9);
    for (const element of credentials) {
      expect(getComputedStyle(element).webkitTextFillColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(element).textShadow).toBe("none");
      expect(element.getBoundingClientRect().width).toBeGreaterThan(0);
      if (element instanceof HTMLInputElement)
        expect(element.value).toContain("fixture-");
      else expect(element.textContent).toContain("fixture-");
    }
    const copy = view.getByRole("button", { name: "Copy", exact: true });
    await expect.element(copy).toBeVisible();
    await expect.element(copy).toBeEnabled();
    expect(getComputedStyle(copy.element()).webkitTextFillColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
  } finally {
    await view.unmount();
  }
});
