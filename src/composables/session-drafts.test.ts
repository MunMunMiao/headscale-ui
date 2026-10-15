import { expect, test } from "vitest";
import { createSessionDrafts } from "./session-drafts";

test("open drafts retain the original owner across switches until an explicit discard", () => {
  const drafts = createSessionDrafts();
  const editor = {};
  drafts.setActive(editor, true);
  expect(drafts.hold({ id: "a", name: "Server A" })).toBe(true);
  expect(drafts.isCurrent()).toBe(false);
  expect(drafts.getSnapshot()).toEqual({
    stale: { profileId: "a", name: "Server A" },
    viewEpoch: 0,
  });
  drafts.release(editor);
  drafts.hold({ id: "b", name: "Server B" });
  expect(drafts.getSnapshot().stale?.profileId).toBe("a");
  drafts.discard();
  expect(drafts.isCurrent()).toBe(true);
  expect(drafts.getSnapshot()).toEqual({ stale: null, viewEpoch: 1 });
});
test("closed or unmounted editors do not block a switch; an unmounted dirty policy still does", () => {
  const drafts = createSessionDrafts();
  const editor = {};
  expect(drafts.hold({ id: "a", name: "A" })).toBe(false);
  drafts.setActive(editor, true);
  drafts.setActive(editor, false);
  expect(drafts.hold({ id: "a", name: "A" })).toBe(false);
  drafts.setActive(editor, true);
  drafts.release(editor);
  expect(drafts.hold({ id: "a", name: "A" })).toBe(false);
  expect(drafts.hold({ id: "a", name: "A" }, true)).toBe(true);
});
test("reports whether any editor is open", () => {
  const drafts = createSessionDrafts();
  const editor = {};
  expect(drafts.hasActiveDrafts()).toBe(false);
  drafts.setActive(editor, true);
  expect(drafts.hasActiveDrafts()).toBe(true);
  drafts.release(editor);
  expect(drafts.hasActiveDrafts()).toBe(false);
});
