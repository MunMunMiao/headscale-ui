import { describe, expect, test, vi } from "vitest";
import type { HeadscaleNode, HeadscaleUser } from "@/api/contracts";
import { csvCell, downloadCsv } from "./csv";
import { DATE_TIME_FORMAT, formatDate } from "./format";
import {
  nodeDisplayName,
  nodeOwner,
  nodePendingRoutes,
  nodeRevocationTargets,
  nodeStatusLabel,
} from "./node";
import { isExitRoute } from "./status-class";
import { normalizedBaseUrl, parseList, shortSecret } from "./strings";
import { hasVisibleUser, isTagManagedDeviceUser, userLabel } from "./user";

function buildUser(overrides: Partial<HeadscaleUser> = {}): HeadscaleUser {
  return { id: "user-a", name: "user-a", ...overrides };
}

function buildNode(overrides: Partial<HeadscaleNode> = {}): HeadscaleNode {
  return {
    id: "node-a",
    ipAddresses: ["100.64.0.1"],
    name: "node-a",
    online: false,
    approvedRoutes: [],
    availableRoutes: [],
    subnetRoutes: [],
    tags: [],
    ...overrides,
  };
}

describe("parseList", () => {
  test("splits and trims comma- or newline-delimited text", () => {
    expect(parseList("tag:first, tag:second\ntag:third\n")).toEqual([
      "tag:first",
      "tag:second",
      "tag:third",
    ]);
  });

  test.each(["", " , \n , "])(
    "returns an empty list for blank text: %j",
    (value) => {
      expect(parseList(value)).toEqual([]);
    },
  );
});

describe("CSV", () => {
  test("quotes every cell and escapes embedded quotes", () => {
    expect(csvCell('A "quoted" value')).toBe('"A ""quoted"" value"');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(false)).toBe('"false"');
    expect(csvCell(0)).toBe('"0"');
  });

  test.each(["=", "+", "-", "@", "\t", "\r"])(
    "neutralises a leading %j",
    (c) => {
      expect(csvCell(`${c}x`)).toBe(`"'${c}x"`);
    },
  );

  test("prefixes before doubling quotes and leaves other values alone", () => {
    expect(csvCell('=HYPERLINK("http://x","c")')).toBe(
      '"\'=HYPERLINK(""http://x"",""c"")"',
    );
    expect(csvCell(-5)).toBe('"-5"');
    for (const safe of [
      "a=b",
      "user@x.io",
      "100.64.0.1",
      "::/0",
      " =lead-space",
      "2024-01-02T03:04:05Z",
    ]) {
      expect(csvCell(safe)).toBe(`"${safe}"`);
    }
  });

  function stubCsvDownload(blobUrl: string, onClick: () => void = () => {}) {
    const link = { download: "", href: "" };
    const state: {
      blob: Blob | MediaSource | undefined;
      revoked: string;
    } = { blob: undefined, revoked: "" };
    // The page builds a real anchor; only click(), which would start a download, is observed.
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        link.download = this.download;
        link.href = this.href;
        onClick();
      });
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((value) => {
        state.blob = value;
        return blobUrl;
      });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation((url) => {
        state.revoked = url;
      });
    return {
      link,
      state,
      restore(this: void) {
        click.mockRestore();
        create.mockRestore();
        revoke.mockRestore();
      },
    };
  }

  test("downloads the rendered CSV and revokes its object URL", async () => {
    let clicks = 0;
    const { link, state, restore } = stubCsvDownload("blob:test-csv", () => {
      clicks++;
    });

    vi.useFakeTimers();
    try {
      downloadCsv(
        "devices.csv",
        ["name", "active", "count"],
        [
          { name: 'A "quoted" device', active: true, count: 2 },
          { name: "Second", active: undefined, count: 3 },
        ],
      );
      // Revoking during click() can cancel a download that has not read the blob yet.
      expect(state.revoked).toBe("");
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
      restore();
    }

    expect(link.download).toBe("devices.csv");
    expect(link.href).toBe("blob:test-csv");
    expect(clicks).toBe(1);
    expect(state.revoked).toBe("blob:test-csv");
    if (!(state.blob instanceof Blob)) throw new Error("expected a Blob");
    expect(state.blob.type).toBe("text/csv;charset=utf-8");
    // The UTF-8 byte order mark makes Excel read non-ASCII names correctly.
    const bytes = new Uint8Array(await state.blob.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe(
      '"name","active","count"\n"A ""quoted"" device","true","2"\n"Second","","3"',
    );
  });

  test("writes only the declared header row for an empty export", async () => {
    const { state, restore } = stubCsvDownload("blob:empty-csv");

    try {
      downloadCsv("empty.csv", ["name", "owner"], []);
    } finally {
      restore();
    }

    if (!(state.blob instanceof Blob)) throw new Error("expected a Blob");
    expect(await state.blob.text()).toBe('"name","owner"');
  });

  test("neutralises formulas in downloaded cells but not negative numbers", async () => {
    const { state, restore } = stubCsvDownload("blob:formula-csv");

    try {
      downloadCsv(
        "f.csv",
        ["name", "count"],
        [{ name: "=cmd|' /C calc'!A0", count: -1 }],
      );
    } finally {
      restore();
    }

    if (!(state.blob instanceof Blob)) throw new Error("expected a Blob");
    expect(await state.blob.text()).toBe(
      '"name","count"\n"\'=cmd|\' /C calc\'!A0","-1"',
    );
  });
});

describe("date formatting", () => {
  test("uses the fallback for empty values and preserves invalid input", () => {
    expect(formatDate(undefined, "en-US", "Never")).toBe("Never");
    expect(formatDate(null, "en-US", "Never")).toBe("Never");
    expect(formatDate("not-a-date", "en-US", "Never")).toBe("not-a-date");
  });

  test("formats valid values with the requested locale", () => {
    const value = "2024-01-02T03:04:00.000Z";
    const expected = new Intl.DateTimeFormat("en-US", DATE_TIME_FORMAT).format(
      new Date(value),
    );
    expect(formatDate(value, "en-US", "Never")).toBe(expected);
  });

  test.each(["en-US", "zh-Hans"])("shows the year in %s", (locale) => {
    const a = formatDate("2026-06-15T12:00:00Z", locale, "");
    const b = formatDate("2027-06-15T12:00:00Z", locale, "");
    expect(a).not.toBe(b);
    expect(a).toContain("2026");
    expect(b).toContain("2027");
  });

  test("constructs one formatter per locale", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 0; i < 3; i++)
        formatDate("2026-06-15T12:00:00Z", "sv-SE", "");
      expect(spy).toHaveBeenCalledTimes(1);
      formatDate("2026-06-15T12:00:00Z", "nb-NO", "");
      formatDate("2026-06-15T12:00:00Z", "nb-NO", "");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("node display helpers", () => {
  test("prefers the administrator-assigned name over the original hostname", () => {
    expect(
      nodeDisplayName(
        buildNode({ name: "raw-host", givenName: "renamed-host" }),
      ),
    ).toBe("renamed-host");
    expect(nodeDisplayName(buildNode({ name: "raw-host" }))).toBe("raw-host");
  });

  test("returns only routes awaiting approval", () => {
    expect(
      nodePendingRoutes(
        buildNode({
          availableRoutes: ["10.0.0.0/24", "10.1.0.0/24"],
          approvedRoutes: ["10.0.0.0/24"],
        }),
      ),
    ).toEqual(["10.1.0.0/24"]);
  });

  test("hides absent and tag-managed owners, otherwise resolves their label", () => {
    expect(nodeOwner(buildNode(), "Unknown")).toBe("");
    expect(
      nodeOwner(
        buildNode({ user: buildUser({ name: "tagged-devices" }) }),
        "Unknown",
      ),
    ).toBe("");
    expect(
      nodeOwner(
        buildNode({ user: buildUser({ displayName: "Visible User" }) }),
        "Unknown",
      ),
    ).toBe("Visible User");
  });

  test("selects labels for online, offline, and expired nodes", () => {
    const labels = { online: "Online", offline: "Offline", expired: "Expired" };
    expect(nodeStatusLabel(buildNode({ online: true }), labels)).toBe("Online");
    expect(nodeStatusLabel(buildNode(), labels)).toBe("Offline");
    expect(
      nodeStatusLabel(
        buildNode({ expiry: new Date(Date.now() - 60_000).toISOString() }),
        labels,
      ),
    ).toBe("Expired");
  });
});

describe("nodeRevocationTargets", () => {
  test("returns a plain subnet alone and never pulls in exit routes", () => {
    const node = buildNode({
      approvedRoutes: ["10.0.0.0/24", "0.0.0.0/0", "::/0"],
    });
    expect(nodeRevocationTargets(node, "10.0.0.0/24")).toEqual(["10.0.0.0/24"]);
  });

  test.each(["0.0.0.0/0", "::/0"])(
    "revokes exit routes as a pair via %s",
    (route) => {
      const node = buildNode({
        approvedRoutes: ["0.0.0.0/0", "::/0", "10.0.0.0/24"],
      });
      expect(nodeRevocationTargets(node, route)).toEqual(["0.0.0.0/0", "::/0"]);
    },
  );

  test("returns nothing for a route that is not approved", () => {
    expect(
      nodeRevocationTargets(
        buildNode({ approvedRoutes: ["10.0.0.0/24"] }),
        "10.1.0.0/24",
      ),
    ).toEqual([]);
  });
});

describe("exit routes", () => {
  test("recognizes both exit-route forms", () => {
    expect(isExitRoute("0.0.0.0/0")).toBe(true);
    expect(isExitRoute("::/0")).toBe(true);
    expect(isExitRoute("10.0.0.0/24")).toBe(false);
  });
});

describe("string helpers", () => {
  test("normalizes whitespace and one trailing slash", () => {
    expect(normalizedBaseUrl("  https://example.invalid/  ")).toBe(
      "https://example.invalid",
    );
    expect(normalizedBaseUrl("https://example.invalid//")).toBe(
      "https://example.invalid/",
    );
  });

  test("uses a fallback, preserves short secrets, and truncates long ones", () => {
    expect(shortSecret(undefined, "Unavailable")).toBe("Unavailable");
    expect(shortSecret("short-value", "Unavailable")).toBe("short-value");
    expect(shortSecret("abcdefghijklmnopqrstuvwx", "Unavailable")).toBe(
      "abcdefghijkl...uvwx",
    );
  });
});

describe("user helpers", () => {
  test("identifies tag-managed users and visible users", () => {
    const tagged = buildUser({ name: "tagged-devices" });
    const visible = buildUser();
    expect(isTagManagedDeviceUser()).toBe(false);
    expect(isTagManagedDeviceUser(tagged)).toBe(true);
    expect(isTagManagedDeviceUser(visible)).toBe(false);
    expect(hasVisibleUser()).toBe(false);
    expect(hasVisibleUser(null)).toBe(false);
    expect(hasVisibleUser(tagged)).toBe(false);
    expect(hasVisibleUser(visible)).toBe(true);
  });

  test("uses display name, name, email, then fallback in order", () => {
    expect(
      userLabel(
        buildUser({ displayName: "Display", email: "email@example.invalid" }),
        "X",
      ),
    ).toBe("Display");
    expect(
      userLabel(
        buildUser({ name: "Name", email: "email@example.invalid" }),
        "X",
      ),
    ).toBe("Name");
    expect(
      userLabel(buildUser({ name: "", email: "email@example.invalid" }), "X"),
    ).toBe("email@example.invalid");
    expect(userLabel(buildUser({ name: "", email: "" }), "Fallback")).toBe(
      "Fallback",
    );
    expect(userLabel(undefined, "Fallback")).toBe("Fallback");
    expect(userLabel(null, "Fallback")).toBe("Fallback");
  });
});
