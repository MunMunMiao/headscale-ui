import { describe, expect, test, vi } from "vitest";
import type { HeadscaleNode, HeadscaleUser, PreAuthKey } from "@/api/contracts";
import { csvCell, downloadCsv } from "./csv";
import { DATE_TIME_FORMAT, formatDate } from "./format";
import {
  nodeDisplayName,
  nodeOwner,
  nodePendingRoutes,
  nodeRevocationTargets,
  nodeStatusLabel,
} from "./node";
import {
  apiKeyStatusClass,
  approvedRouteClass,
  deviceTagClass,
  isExitRoute,
  keyEphemeralClass,
  keyKindClass,
  keyStatusClass,
  keyTagClass,
  nodeStatusClass,
  pendingRouteClass,
} from "./status-class";
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

function buildKey(overrides: Partial<PreAuthKey> = {}): PreAuthKey {
  return {
    id: "key-a",
    key: "test-key",
    reusable: false,
    ephemeral: false,
    used: false,
    aclTags: [],
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

  test.each(["", " , \n , "])("returns an empty list for blank text: %j", (value) => {
    expect(parseList(value)).toEqual([]);
  });
});

describe("CSV", () => {
  test("quotes every cell and escapes embedded quotes", () => {
    expect(csvCell('A "quoted" value')).toBe('"A ""quoted"" value"');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(false)).toBe('"false"');
    expect(csvCell(0)).toBe('"0"');
  });

  test.each(["=", "+", "-", "@", "\t", "\r"])("neutralises a leading %j", (c) => {
    expect(csvCell(`${c}x`)).toBe(`"'${c}x"`);
  });

  test("prefixes before doubling quotes and leaves other values alone", () => {
    expect(csvCell('=HYPERLINK("http://x","c")')).toBe('"\'=HYPERLINK(""http://x"",""c"")"');
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

  test("downloads the rendered CSV and revokes its object URL", async () => {
    let blob: Blob | undefined;
    let revokedUrl = "";
    let clicks = 0;
    const link = {
      download: "",
      href: "",
      click: () => void clicks++,
    };
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => link },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (value: Blob) => {
        blob = value;
        return "blob:test-csv";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (value: string) => {
        revokedUrl = value;
      },
    });

    try {
      downloadCsv(
        "devices.csv",
        ["name", "active", "count"],
        [
          { name: 'A "quoted" device', active: true, count: 2 },
          { name: "Second", active: undefined, count: 3 },
        ],
      );
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    }

    expect(link.download).toBe("devices.csv");
    expect(link.href).toBe("blob:test-csv");
    expect(clicks).toBe(1);
    expect(revokedUrl).toBe("blob:test-csv");
    expect(blob?.type).toBe("text/csv;charset=utf-8");
    expect(await blob?.text()).toBe(
      '"name","active","count"\n"A ""quoted"" device","true","2"\n"Second","","3"',
    );
  });

  test("writes only the declared header row for an empty export", async () => {
    let blob: Blob | undefined;
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ href: "", download: "", click() {} }) },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (value: Blob) => {
        blob = value;
        return "blob:empty-csv";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value() {} });

    try {
      downloadCsv("empty.csv", ["name", "owner"], []);
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    }

    expect(await blob?.text()).toBe('"name","owner"');
  });

  test("neutralises formulas in downloaded cells but not negative numbers", async () => {
    let blob: Blob | undefined;
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ href: "", download: "", click() {} }) },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (value: Blob) => {
        blob = value;
        return "blob:formula-csv";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value() {} });

    try {
      downloadCsv("f.csv", ["name", "count"], [{ name: "=cmd|' /C calc'!A0", count: -1 }]);
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    }

    expect(await blob?.text()).toBe('"name","count"\n"\'=cmd|\' /C calc\'!A0","-1"');
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
    const expected = new Intl.DateTimeFormat("en-US", DATE_TIME_FORMAT).format(new Date(value));
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
      for (let i = 0; i < 3; i++) formatDate("2026-06-15T12:00:00Z", "sv-SE", "");
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
    expect(nodeDisplayName(buildNode({ name: "raw-host", givenName: "renamed-host" }))).toBe(
      "renamed-host",
    );
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
    expect(nodeOwner(buildNode({ user: buildUser({ name: "tagged-devices" }) }), "Unknown")).toBe(
      "",
    );
    expect(
      nodeOwner(buildNode({ user: buildUser({ displayName: "Visible User" }) }), "Unknown"),
    ).toBe("Visible User");
  });

  test("selects labels for online, offline, and expired nodes", () => {
    const labels = { online: "Online", offline: "Offline", expired: "Expired" };
    expect(nodeStatusLabel(buildNode({ online: true }), labels)).toBe("Online");
    expect(nodeStatusLabel(buildNode(), labels)).toBe("Offline");
    expect(
      nodeStatusLabel(buildNode({ expiry: new Date(Date.now() - 60_000).toISOString() }), labels),
    ).toBe("Expired");
  });
});

describe("nodeRevocationTargets", () => {
  test("returns a plain subnet alone and never pulls in exit routes", () => {
    const node = buildNode({ approvedRoutes: ["10.0.0.0/24", "0.0.0.0/0", "::/0"] });
    expect(nodeRevocationTargets(node, "10.0.0.0/24")).toEqual(["10.0.0.0/24"]);
  });

  test.each(["0.0.0.0/0", "::/0"])("revokes exit routes as a pair via %s", (route) => {
    const node = buildNode({ approvedRoutes: ["0.0.0.0/0", "::/0", "10.0.0.0/24"] });
    expect(nodeRevocationTargets(node, route)).toEqual(["0.0.0.0/0", "::/0"]);
  });

  test("returns nothing for a route that is not approved", () => {
    expect(
      nodeRevocationTargets(buildNode({ approvedRoutes: ["10.0.0.0/24"] }), "10.1.0.0/24"),
    ).toEqual([]);
  });
});

describe("status classes", () => {
  test("maps api-key status to expired or active", () => {
    expect(
      apiKeyStatusClass({ expiration: new Date(Date.now() - 60_000).toISOString() }),
    ).toContain("rose");
    expect(
      apiKeyStatusClass({ expiration: new Date(Date.now() + 3_600_000).toISOString() }),
    ).toContain("emerald");
    expect(apiKeyStatusClass({ expiration: null })).toContain("emerald");
    expect(apiKeyStatusClass({})).toContain("emerald");
  });

  test("recognizes both exit-route forms", () => {
    expect(isExitRoute("0.0.0.0/0")).toBe(true);
    expect(isExitRoute("::/0")).toBe(true);
    expect(isExitRoute("10.0.0.0/24")).toBe(false);
  });

  test("maps all node states", () => {
    expect(nodeStatusClass(buildNode({ online: true }))).toContain("emerald");
    expect(nodeStatusClass(buildNode())).toContain("slate");
    expect(
      nodeStatusClass(buildNode({ expiry: new Date(Date.now() - 60_000).toISOString() })),
    ).toContain("rose");
  });

  test("maps auth-key status and kind", () => {
    expect(keyStatusClass(buildKey({ used: true }))).toContain("sky");
    expect(
      keyStatusClass(buildKey({ expiration: new Date(Date.now() - 60_000).toISOString() })),
    ).toContain("rose");
    expect(keyStatusClass(buildKey())).toContain("emerald");
    expect(keyKindClass(buildKey({ reusable: true }))).toContain("teal");
    expect(keyKindClass(buildKey())).toContain("violet");
    expect(keyEphemeralClass()).toContain("amber");
  });

  test("distinguishes approved, pending subnet, and pending exit routes", () => {
    expect(approvedRouteClass()).toContain("emerald");
    expect(pendingRouteClass("10.0.0.0/24")).toContain("amber");
    expect(pendingRouteClass("::/0")).toContain("rose");
  });

  test("maps device tag keywords and falls back for unknown tags", () => {
    expect(deviceTagClass("tag:server")).toContain("cyan");
    expect(deviceTagClass("tag:workstation")).toContain("fuchsia");
    expect(deviceTagClass("tag:desktop")).toContain("fuchsia");
    expect(deviceTagClass("tag:mobile")).toContain("pink");
    expect(deviceTagClass("tag:phone")).toContain("pink");
    expect(deviceTagClass("tag:db")).toContain("indigo");
    expect(deviceTagClass("tag:database")).toContain("indigo");
    expect(deviceTagClass("tag:unknown")).toContain("emerald");
  });

  test("uses the narrower auth-key tag palette", () => {
    expect(keyTagClass("tag:server")).toContain("cyan");
    expect(keyTagClass("tag:mobile")).toContain("pink");
    expect(keyTagClass("tag:db")).toContain("indigo");
    expect(keyTagClass("tag:desktop")).toContain("slate");
  });
});

describe("string helpers", () => {
  test("normalizes whitespace and one trailing slash", () => {
    expect(normalizedBaseUrl("  https://example.invalid/  ")).toBe("https://example.invalid");
    expect(normalizedBaseUrl("https://example.invalid//")).toBe("https://example.invalid/");
  });

  test("uses a fallback, preserves short secrets, and truncates long ones", () => {
    expect(shortSecret(undefined, "Unavailable")).toBe("Unavailable");
    expect(shortSecret("short-value", "Unavailable")).toBe("short-value");
    expect(shortSecret("abcdefghijklmnopqrstuvwx", "Unavailable")).toBe("abcdefghijkl...uvwx");
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
      userLabel(buildUser({ displayName: "Display", email: "email@example.invalid" }), "X"),
    ).toBe("Display");
    expect(userLabel(buildUser({ name: "Name", email: "email@example.invalid" }), "X")).toBe(
      "Name",
    );
    expect(userLabel(buildUser({ name: "", email: "email@example.invalid" }), "X")).toBe(
      "email@example.invalid",
    );
    expect(userLabel(buildUser({ name: "", email: "" }), "Fallback")).toBe("Fallback");
    expect(userLabel(undefined, "Fallback")).toBe("Fallback");
    expect(userLabel(null, "Fallback")).toBe("Fallback");
  });
});
