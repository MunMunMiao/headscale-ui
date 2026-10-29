import { expect, test } from "vitest";

const modules = import.meta.glob("./*.tsx");

test.each([
  ["form", ["useAppForm", "submitForm"]],
  ["notification-host", ["NotificationHost"]],
  ["tooltip", ["Tooltip", "TooltipProvider"]],
  ["notice", ["Notice"]],
  ["copy-button", ["CopyButton"]],
  ["date-time-picker", ["DateTimePicker"]],
  ["time-picker", ["TimePicker"]],
] as const)(
  "the app layer exposes the project-owned %s API",
  async (name, exports) => {
    const load = modules[`./${name}.tsx`];
    expect(
      load,
      `${name} belongs in components/app, not the upstream ui registry`,
    ).toBeTypeOf("function");
    const module = await load();
    for (const name of exports)
      expect(Reflect.get(module as object, name)).toBeTypeOf("function");
  },
);
