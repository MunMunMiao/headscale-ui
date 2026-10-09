import assert from "node:assert/strict";
import * as fs from "node:fs";

export function getIpv6InitializationState(
  disabled: number,
  addressGeneration: number,
  addresses: readonly { scope: number; flags: number }[],
): "ready" | "pending" | "failed" {
  if (addresses.some(({ flags }) => flags & 0x08)) return "failed";
  if (addresses.some(({ flags }) => flags & 0x40)) return "pending";
  if (disabled === 1 || addressGeneration === 1) return "ready";
  return addresses.some(({ scope }) => scope === 0x20) ? "ready" : "pending";
}

export async function waitForDockerIpv6(networkId: string): Promise<void> {
  assert.match(networkId, /^[a-f0-9]{64}$/, "Expected the owned Docker network's full ID");
  if (process.platform !== "linux") return;

  // These private fixtures use Docker's default bridge name. A bridge outside this
  // namespace cannot send address changes to the local Chrome process.
  const bridge = `br-${networkId.slice(0, 12)}`;
  const portsPath = `/sys/class/net/${bridge}/brif`;
  if (!fs.existsSync(portsPath) || !fs.existsSync("/proc/net/if_inet6")) return;

  const started = performance.now();
  while (true) {
    const interfaces = [bridge, ...fs.readdirSync(portsPath)];
    assert.ok(interfaces.length > 1, "The owned fixture bridge must have attached endpoints");
    const addresses = fs
      .readFileSync("/proc/net/if_inet6", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/));
    const states = interfaces.map((name) => {
      const disabled = Number(
        fs.readFileSync(`/proc/sys/net/ipv6/conf/${name}/disable_ipv6`, "utf8").trim(),
      );
      const generation = Number(
        fs.readFileSync(`/proc/sys/net/ipv6/conf/${name}/addr_gen_mode`, "utf8").trim(),
      );
      assert.ok([0, 1].includes(disabled) && [0, 1, 2, 3].includes(generation));
      const ownAddresses = addresses
        .filter((fields) => fields[5] === name)
        .map((fields) => ({
          scope: Number.parseInt(fields[3] ?? "", 16),
          flags: Number.parseInt(fields[4] ?? "", 16),
        }));
      return {
        name,
        disabled,
        generation,
        addresses: ownAddresses,
        state: getIpv6InitializationState(disabled, generation, ownAddresses),
      };
    });
    assert.ok(
      !states.some(({ state }) => state === "failed"),
      `Owned Docker interface failed IPv6 duplicate address detection: ${JSON.stringify(states)}`,
    );
    if (states.every(({ state }) => state === "ready")) return;
    assert.ok(
      performance.now() - started < 10_000,
      `Owned Docker interfaces did not finish IPv6 initialization: ${JSON.stringify(states)}`,
    );
    // Poll the kernel condition; proceed immediately once initialization completes.
    await Bun.sleep(25);
  }
}
