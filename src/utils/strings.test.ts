import { expect, test } from "vitest";
import { tailscaleUpCommand } from "./strings";

test("builds the login-server command with a normalized base URL", () => {
  expect(tailscaleUpCommand("https://hs.example/ ", "key1")).toBe(
    "tailscale up --login-server https://hs.example --authkey key1",
  );
});

test("appends the exit-node flag only when requested", () => {
  expect(tailscaleUpCommand("https://hs.example", "key1", true)).toBe(
    "tailscale up --login-server https://hs.example --authkey key1 --advertise-exit-node",
  );
});
