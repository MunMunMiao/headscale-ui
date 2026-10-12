import { expect, test } from "vitest";
import { isTimestampExpired, msUntilNextExpiry, nodeConnectionStatus } from "./node-status";

const now = Date.parse("2026-05-05T00:00:00Z");
const expiredAt = "2026-05-04T00:00:00Z";
const futureExpiry = "2026-05-06T00:00:00Z";

test("detects timestamp expiration relative to a supplied clock", () => {
  expect(isTimestampExpired(expiredAt, now)).toBe(true);
  expect(isTimestampExpired(futureExpiry, now)).toBe(false);
  expect(isTimestampExpired(undefined, now)).toBe(false);
  expect(isTimestampExpired(null, now)).toBe(false);
});

test("keeps online devices online even when their expiry timestamp is stale", () => {
  expect(nodeConnectionStatus({ online: true, expiry: expiredAt }, now)).toBe("online");
});

test("shows expired only for offline devices whose expiry timestamp is stale", () => {
  expect(nodeConnectionStatus({ online: false, expiry: expiredAt }, now)).toBe("expired");
  expect(nodeConnectionStatus({ online: false, expiry: futureExpiry }, now)).toBe("offline");
});

test("msUntilNextExpiry returns null without a future candidate", () => {
  expect(msUntilNextExpiry([], now)).toBeNull();
  expect(msUntilNextExpiry([expiredAt, "garbage", "", null, undefined], now)).toBeNull();
});

test("msUntilNextExpiry returns the nearest future instant plus one millisecond", () => {
  const soon = new Date(now + 5000).toISOString();
  const later = new Date(now + 90000).toISOString();
  expect(msUntilNextExpiry([later, expiredAt, null, soon, "garbage"], now)).toBe(5001);
  expect(msUntilNextExpiry([new Date(now).toISOString()], now)).toBe(1);
  expect(msUntilNextExpiry(new Set([later]), now)).toBe(90001);
});

test("msUntilNextExpiry caps the delay at the largest timer value", () => {
  const sixtyDays = new Date(now + 60 * 24 * 3600 * 1000).toISOString();
  expect(msUntilNextExpiry([sixtyDays], now)).toBe(2147483647);
});
