import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { setLocale } from "@/i18n";
import { prepareTestSession, SessionTestProviders } from "@/test/session";
import { CopyButton } from "./copy-button";

const FAILED = "Copy failed. Select the text and copy it manually.";
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(async () => {
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
  await setLocale("en-US");
});

function stubClipboard(
  writeText: ((value: string) => Promise<void>) | undefined,
) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

async function mount(element: React.ReactNode) {
  const session = await prepareTestSession();
  await render(
    <SessionTestProviders session={session}>{element}</SessionTestProviders>,
  );
}

function Switchable() {
  const [value, setValue] = useState("first");
  return (
    <>
      <CopyButton value={value} data-testid="copy">
        Copy
      </CopyButton>
      <button
        type="button"
        data-testid="next"
        onClick={() => setValue("second")}
      >
        next
      </button>
    </>
  );
}

// A resolved write must be visible and revert so the button is reusable.
test("a resolved write shows Copied and reverts after 1200 ms", async () => {
  const writes: string[] = [];
  stubClipboard(async (value) => {
    writes.push(value);
  });
  await mount(
    <CopyButton value="secret" data-testid="copy">
      Copy
    </CopyButton>,
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await page.getByTestId("copy").click();
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
  expect(writes).toEqual(["secret"]);
  await vi.advanceTimersByTimeAsync(1199);
  expect(vi.getTimerCount()).toBe(1);
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
  await vi.advanceTimersByTimeAsync(2);
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copy");
  await expect
    .element(page.getByTestId("copy"))
    .not.toHaveTextContent("Copied");
});

// A rejected write must not be silent or an unhandled rejection; retry must work.
test("a rejected write shows Copy failed without an unhandled rejection and can be retried", async () => {
  const unhandled: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) =>
    unhandled.push(event.reason);
  window.addEventListener("unhandledrejection", listener);
  try {
    let calls = 0;
    stubClipboard(async () => {
      if (++calls === 1) throw new DOMException("denied", "NotAllowedError");
    });
    await mount(
      <CopyButton value="secret" data-testid="copy">
        Copy
      </CopyButton>,
    );
    await page.getByTestId("copy").click();
    await expect.element(page.getByTestId("copy")).toHaveTextContent(FAILED);
    await expect.element(page.getByTestId("copy")).toBeEnabled();
    await page.getByTestId("copy").click();
    await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
    expect(calls).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", listener);
  }
});

// http:// pages have no navigator.clipboard; the TypeError must be handled.
test("a missing clipboard reports Copy failed", async () => {
  const unhandled: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) =>
    unhandled.push(event.reason);
  window.addEventListener("unhandledrejection", listener);
  try {
    stubClipboard(undefined);
    await mount(
      <CopyButton value="secret" data-testid="copy">
        Copy
      </CopyButton>,
    );
    await page.getByTestId("copy").click();
    await expect.element(page.getByTestId("copy")).toHaveTextContent(FAILED);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", listener);
  }
});

test("the failure label lasts 5000 ms", async () => {
  stubClipboard(async () => {
    throw new Error("denied");
  });
  await mount(
    <CopyButton value="secret" data-testid="copy">
      Copy
    </CopyButton>,
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await page.getByTestId("copy").click();
  await expect.element(page.getByTestId("copy")).toHaveTextContent(FAILED);
  await vi.advanceTimersByTimeAsync(4999);
  expect(vi.getTimerCount()).toBe(1);
  await expect.element(page.getByTestId("copy")).toHaveTextContent(FAILED);
  await vi.advanceTimersByTimeAsync(2);
  await expect.element(page.getByTestId("copy")).not.toHaveTextContent(FAILED);
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copy");
});

// A new credential replacing the old one must not inherit a stale Copied label.
test("changing the value immediately shows the idle label", async () => {
  stubClipboard(async () => {});
  await mount(<Switchable />);
  await page.getByTestId("copy").click();
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
  await page.getByTestId("next").click();
  await expect
    .element(page.getByTestId("copy"))
    .not.toHaveTextContent("Copied");
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copy");
});

test("unmounting before the timer leaves no pending timer", async () => {
  stubClipboard(async () => {});
  const session = await prepareTestSession();
  const view = await render(
    <SessionTestProviders session={session}>
      <CopyButton value="secret" data-testid="copy">
        Copy
      </CopyButton>
    </SessionTestProviders>,
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await page.getByTestId("copy").click();
  await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
  const pending = vi.getTimerCount();
  expect(pending).toBeGreaterThan(0);
  await view.unmount();
  expect(vi.getTimerCount()).toBeLessThan(pending);
});

test("the failure text is localized", async () => {
  stubClipboard(undefined);
  await mount(
    <CopyButton value="secret" data-testid="copy">
      Copy
    </CopyButton>,
  );
  await setLocale("zh-Hant-TW");
  await page.getByTestId("copy").click();
  await expect
    .element(page.getByTestId("copy"))
    .toHaveTextContent("複製失敗。請選取文字後手動複製。");
});
