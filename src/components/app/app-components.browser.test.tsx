import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { NativeSelect, NativeSelectOption } from "./native-select";

const originalDirection = document.documentElement.dir;

afterEach(() => {
  document.documentElement.dir = originalDirection;
});

test.each(["ltr", "rtl"])(
  "application selects retain a usable 36px touch target in %s",
  async (direction) => {
    document.documentElement.dir = direction;
    await render(
      <NativeSelect aria-label="Filter">
        <NativeSelectOption>All devices</NativeSelectOption>
      </NativeSelect>,
    );
    const select = page.getByRole("combobox", { name: "Filter" }).element();
    expect(select.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
  },
);
