import { describe, expect, test } from "vitest";
import { getProductCopy } from "@/i18n/product-copy";
import {
  API_KEY_EXPIRY_DAYS,
  AUTH_KEY_EXPIRY_DAYS,
  authKeyDialogLabels,
  authKeyDialogUser,
  dateTimeLocalToIso,
  defaultExpirationLocal,
  isFutureExpiration,
  isoToDateTimeLocal,
  toAuthKeyDefaults,
} from "./create-auth-key-dialog";

describe("auth key date-time helpers", () => {
  test("round trips ISO timestamps through local date-time values", () => {
    const iso = "2026-06-01T00:00:00.000Z";
    expect(dateTimeLocalToIso(isoToDateTimeLocal(iso))).toBe(iso);
  });

  test("returns an empty local date-time value for invalid timestamps", () => {
    expect(isoToDateTimeLocal("")).toBe("");
    expect(isoToDateTimeLocal("not-a-date")).toBe("");
    expect(dateTimeLocalToIso("not-a-date")).toBe("not-a-date");
  });
});

describe("relative default expiration", () => {
  test("exposes the shared day constants", () => {
    expect(AUTH_KEY_EXPIRY_DAYS).toBe(7);
    expect(API_KEY_EXPIRY_DAYS).toBe(90);
  });

  test.each(["2027-03-01T12:00:00Z", "2031-07-15T03:30:00Z"])(
    "defaults to the given number of days after %s",
    (nowIso) => {
      const now = Date.parse(nowIso);
      const iso = dateTimeLocalToIso(defaultExpirationLocal(7, now));
      const delta = Date.parse(iso) - (now + 7 * 86_400_000);
      expect(delta).toBeGreaterThanOrEqual(-60_000);
      expect(delta).toBeLessThanOrEqual(0);
    },
  );

  test("uses the system clock when no time is given", () => {
    const delta = Date.parse(dateTimeLocalToIso(defaultExpirationLocal(1))) - Date.now();
    expect(delta).toBeGreaterThan(86_400_000 - 120_000);
    expect(delta).toBeLessThanOrEqual(86_400_000);
  });

  test("accepts only strictly future expirations", () => {
    const now = Date.parse("2027-03-01T12:00:30Z");
    const local = (offset: number) => isoToDateTimeLocal(new Date(now + offset).toISOString());
    expect(isFutureExpiration(local(-86_400_000), now)).toBe(false);
    expect(isFutureExpiration(local(0), now)).toBe(false);
    expect(isFutureExpiration("", now)).toBe(false);
    expect(isFutureExpiration("garbage", now)).toBe(false);
    expect(isFutureExpiration(local(60_000), now)).toBe(true);
  });

  test("accepts a future value against the system clock", () => {
    expect(isFutureExpiration(defaultExpirationLocal(1))).toBe(true);
  });

  test("dialog defaults carry no expiration and join tags", () => {
    const defaults = toAuthKeyDefaults({
      user: "2",
      reusable: true,
      ephemeral: false,
      expiration: "2027-03-08T12:00:00.000Z",
      aclTags: ["tag:a", "tag:b"],
    });
    expect(defaults).toEqual({
      user: "2",
      reusable: true,
      ephemeral: false,
      aclTags: "tag:a, tag:b",
    });
    expect("expiration" in defaults).toBe(false);
  });

  test("an owner-less payload defaults to the empty owner", () => {
    expect(
      toAuthKeyDefaults({
        reusable: false,
        ephemeral: true,
        expiration: "2027-03-08T12:00:00.000Z",
        aclTags: ["tag:server"],
      }),
    ).toEqual({ user: "", reusable: false, ephemeral: true, aclTags: "tag:server" });
  });
});

describe("authKeyDialogLabels", () => {
  test("maps the shared product copy to exactly the dialog's labels", () => {
    const copy = getProductCopy("en-US");
    expect(authKeyDialogLabels(copy)).toEqual({
      title: copy.createInvite,
      description: copy.invitesSubtitle,
      owner: copy.inviteOwner,
      expiration: copy.inviteExpiration,
      aclTags: copy.aclTags,
      reusable: copy.reusable,
      ephemeral: copy.ephemeral,
      cancel: copy.cancel,
      submit: copy.createInvite,
      time: copy.time,
      hour: copy.hour,
      minute: copy.minute,
    });
  });
});

describe("authKeyDialogUser", () => {
  // Two people may share a display name; the username tells them apart.
  test.each([
    [{ id: "1", name: "alice", displayName: "Alice Ops" }, "Alice Ops (alice)"],
    [{ id: "2", name: "bob", displayName: "bob" }, "bob"],
    [{ id: "3", name: "carol" }, "carol"],
    [{ id: "4", name: "", displayName: "Dana", email: "dana@example.com" }, "Dana"],
    [{ id: "5", name: "" }, "Unknown"],
  ])("labels %o as %s", (user, label) => {
    expect(authKeyDialogUser(user, "Unknown")).toEqual({ id: user.id, label });
  });
});
