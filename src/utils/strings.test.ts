import { expect, test } from "vitest";
import { tailscaleUpCommand } from "./strings";

test("builds the login-server command with a normalized base URL", () => {
  expect(tailscaleUpCommand("https://hs.example/ ", "key1")).toBe(
    "tailscale up --login-server 'https://hs.example' --authkey 'key1'",
  );
});

test.each([
  ["https://[::1]:8080", "key1", "'https://[::1]:8080' --authkey 'key1'"],
  [
    "https://hs.example/a b?x=1&y=2",
    "a b",
    "'https://hs.example/a b?x=1&y=2' --authkey 'a b'",
  ],
  [
    "https://hs.example/it's",
    "key'1",
    "'https://hs.example/it'\\''s' --authkey 'key'\\''1'",
  ],
  [
    "https://hs.example/$(id)`id`",
    "$HOME; exit",
    "'https://hs.example/$(id)`id`' --authkey '$HOME; exit'",
  ],
  ["https://hs.example", "", "'https://hs.example' --authkey ''"],
])(
  "quotes URL %s and secret as literal POSIX arguments without executing them",
  (url, key, args) => {
    expect(tailscaleUpCommand(url, key)).toBe(
      `tailscale up --login-server ${args}`,
    );
  },
);

test("appends the exit-node flag only when requested", () => {
  expect(tailscaleUpCommand("https://hs.example", "key1", true)).toBe(
    "tailscale up --login-server 'https://hs.example' --authkey 'key1' --advertise-exit-node",
  );
});
