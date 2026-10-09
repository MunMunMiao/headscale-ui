import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { getIpv6InitializationState, waitForDockerIpv6 } from "./docker-network";

describe("IPv6 interface initialization", () => {
  test("accepts an interface with IPv6 disabled and no addresses", () => {
    expect(getIpv6InitializationState(1, 0, [])).toBe("ready");
  });

  test("does not require a link-local address when address generation is disabled", () => {
    expect(getIpv6InitializationState(0, 1, [])).toBe("ready");
  });

  test.each([
    0, 2, 3,
  ])("waits for a link-local address in address generation mode %i", (addressGeneration) => {
    expect(getIpv6InitializationState(0, addressGeneration, [])).toBe("pending");
  });

  test("accepts an initialized link-local address", () => {
    expect(getIpv6InitializationState(0, 0, [{ scope: 0x20, flags: 0x80 }])).toBe("ready");
  });

  test("does not mistake a global address for the missing link-local address", () => {
    expect(getIpv6InitializationState(0, 0, [{ scope: 0, flags: 0x80 }])).toBe("pending");
  });

  test.each([
    0, 0x20,
  ])("waits for a tentative address with scope %i even when a stable link-local address exists", (scope) => {
    expect(
      getIpv6InitializationState(0, 0, [
        { scope: 0x20, flags: 0x80 },
        { scope, flags: 0xc0 },
      ]),
    ).toBe("pending");
  });

  test("does not ignore an existing tentative address when address generation is disabled", () => {
    expect(getIpv6InitializationState(0, 1, [{ scope: 0x20, flags: 0xc0 }])).toBe("pending");
  });

  test("does not ignore an existing tentative address when IPv6 is disabled", () => {
    expect(getIpv6InitializationState(1, 0, [{ scope: 0x20, flags: 0xc0 }])).toBe("pending");
  });

  test.each([
    [0, 0],
    [0, 0x20],
    [1, 0],
    [1, 0x20],
  ])("fails on duplicate address detection with disabled=%i and scope=%i", (disabled, scope) => {
    expect(
      getIpv6InitializationState(disabled, 0, [
        { scope: 0x20, flags: 0x80 },
        { scope, flags: 0x88 },
      ]),
    ).toBe("failed");
  });

  test("reports duplicate address detection failure before another address still pending", () => {
    expect(
      getIpv6InitializationState(0, 0, [
        { scope: 0x20, flags: 0xc0 },
        { scope: 0, flags: 0x88 },
      ]),
    ).toBe("failed");
  });
});

const ownedNetworkId = "0123456789abcdef".repeat(4);

function observeOwnedNetwork(initialFlags: string) {
  const state = { flags: initialFlags };
  const portsPath = "/sys/class/net/br-0123456789ab/brif";
  const exists = spyOn(fs, "existsSync").mockImplementation(
    (path) => path === portsPath || path === "/proc/net/if_inet6",
  );
  const readdir = spyOn(fs, "readdirSync").mockImplementation(((path: fs.PathLike) => {
    if (path !== portsPath) throw new Error(`Unexpected interface directory: ${path}`);
    return ["veth-owned"];
  }) as typeof fs.readdirSync);
  const readFile = spyOn(fs, "readFileSync").mockImplementation(((
    path: fs.PathOrFileDescriptor,
  ) => {
    if (path === "/proc/net/if_inet6") {
      return [
        "fe800000000000000000000000000001 02 40 20 80 br-0123456789ab",
        `fe800000000000000000000000000002 03 40 20 ${state.flags} veth-owned`,
        "fe800000000000000000000000000003 04 40 20 c0 veth-unrelated",
      ].join("\n");
    }
    if (
      /^\/proc\/sys\/net\/ipv6\/conf\/(br-0123456789ab|veth-owned)\/(disable_ipv6|addr_gen_mode)$/.test(
        String(path),
      )
    ) {
      return "0\n";
    }
    throw new Error(`Unexpected interface file: ${path}`);
  }) as typeof fs.readFileSync);
  return {
    state,
    restore() {
      readFile.mockRestore();
      readdir.mockRestore();
      exists.mockRestore();
    },
  };
}

describe("Docker IPv6 initialization waiter", () => {
  test("rejects an invalid network ID on every platform", async () => {
    await expect(waitForDockerIpv6("not-an-owned-network-id")).rejects.toThrow(
      "Expected the owned Docker network's full ID",
    );
  });

  test.skipIf(process.platform !== "linux")(
    "waits for the owned tentative address and ignores unrelated tentative addresses",
    async () => {
      const network = observeOwnedNetwork("c0");
      try {
        let settled = false;
        const pending = waitForDockerIpv6(ownedNetworkId);
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        expect(settled).toBe(false);

        network.state.flags = "80";
        await pending;
        expect(settled).toBe(true);
      } finally {
        network.restore();
      }
    },
    15_000,
  );

  test.skipIf(process.platform !== "linux")(
    "rejects owned duplicate address detection failure",
    async () => {
      const network = observeOwnedNetwork("88");
      try {
        await expect(waitForDockerIpv6(ownedNetworkId)).rejects.toThrow(
          "Owned Docker interface failed IPv6 duplicate address detection",
        );
      } finally {
        network.restore();
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects initialization that exceeds its deadline",
    async () => {
      const network = observeOwnedNetwork("c0");
      const now = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10_001);
      try {
        await expect(waitForDockerIpv6(ownedNetworkId)).rejects.toThrow(
          "Owned Docker interfaces did not finish IPv6 initialization",
        );
      } finally {
        now.mockRestore();
        network.restore();
      }
    },
  );
});
