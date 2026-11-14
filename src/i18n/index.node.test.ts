// Runs in Node: a loaded page always has a document, so the no-document path is only reachable outside it.
import { expect, test, vi } from "vitest";
import type * as settings from "@/lib/settings-storage";
import { applyStoredLocale } from "./index";
import { i18n } from "./runtime";

// Node has no IndexedDB to hydrate from, so the stored language is supplied at the storage boundary.
vi.mock("@/lib/settings-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof settings>()),
  readSetting: () => "ar",
}));

test("applying the stored language without a document still activates its catalog", async () => {
  expect(typeof document).toBe("undefined");
  await applyStoredLocale();
  expect(i18n.locale).toBe("ar");
});
