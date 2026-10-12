import { beforeAll, expect, test } from "vitest";
import { parsePolicy, serializePolicy } from "../src/domain/policy-designer";
import { applyTemplate, POLICY_TEMPLATES } from "../src/domain/policy-templates";

// Headscale evaluates the policy `tests` block against the live users and nodes without saving it,
// so these cases prove that what the designer serializes means what the UI claims it means.
const baseUrl = process.env.HEADSCALE_E2E_URL?.replace(/\/$/, "");
const apiKey = process.env.HEADSCALE_E2E_API_KEY ?? process.env.VITE_HEADSCALE_E2E_API_KEY;
if (!baseUrl || !apiKey)
  throw new Error("HEADSCALE_E2E_URL and HEADSCALE_E2E_API_KEY are required");

type Policy = Record<string, unknown>;
let target = "";

beforeAll(async () => {
  const response = await fetch(`${baseUrl}/api/v1/node`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const { nodes } = (await response.json()) as {
    nodes: { name: string; ipAddresses: string[] }[];
  };
  const ip = nodes
    .find((node) => node.name === "alice-laptop")
    ?.ipAddresses.find((a) => !a.includes(":"));
  if (!ip) throw new Error("The fixture node alice-laptop must have an IPv4 address");
  target = ip;
});

async function check(policy: Policy) {
  const response = await fetch(`${baseUrl}/api/v1/policy/check`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ policy: JSON.stringify(policy) }),
  });
  return { ok: response.ok, text: await response.text() };
}

async function expectValid(label: string, policy: Policy) {
  const { ok, text } = await check(policy);
  expect(ok, `${label}: ${text}`).toBe(true);
}

// A negative control must fail on an access mismatch, not on a malformed `tests` block.
async function expectAccessMismatch(label: string, policy: Policy) {
  const { ok, text } = await check(policy);
  expect(ok, `${label}: the negative control unexpectedly passed`).toBe(false);
  expect(text, label).toMatch(/test\(s\) failed/);
  expect(text, label).toMatch(/expected (?:ALLOWED, got DENIED|DENIED, got ALLOWED)/);
}

const defaultPolicy = serializePolicy(parsePolicy("{}"));
const nonTailnetTests = [
  ...["tcp", "udp"].map((proto) => ({
    src: "192.0.2.10",
    proto,
    accept: [`198.51.100.20:${proto === "tcp" ? 18080 : 53}`],
  })),
  ...["tcp", "udp"].map((proto) => ({
    src: "2001:db8::10",
    proto,
    accept: [`[2001:db8::20]:${proto === "tcp" ? 18080 : 53}`],
  })),
];

test("the designer default allows non-tailnet IPv4 and IPv6 sources, the old wildcard does not", async () => {
  await expectValid("implicit default", { tests: nonTailnetTests });
  await expectValid("designer default", { ...defaultPolicy, tests: nonTailnetTests });
  await expectAccessMismatch("old wildcard default", {
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    tests: nonTailnetTests,
  });
});

test("a template replaces the open default, appending it after the default stays open", async () => {
  const templated = serializePolicy(applyTemplate(parsePolicy("{}"), POLICY_TEMPLATES[1]));
  const tests = [{ src: "192.0.2.10", proto: "tcp", deny: ["198.51.100.20:18080"] }];
  await expectValid("template replaces the open default", { ...templated, tests });
  await expectAccessMismatch("template appended after the open default", {
    ...templated,
    acls: [...(defaultPolicy.acls as unknown[]), ...(templated.acls as unknown[])],
    tests,
  });
});

test("protocol-specific ACLs survive the designer and HuJSON round trips", async () => {
  const restricted = {
    acls: [
      { action: "accept", src: ["alice@"], dst: [`${target}:18080`], proto: "udp" },
      { action: "accept", src: ["alice@"], dst: [`${target}:18081`], proto: "tcp" },
    ],
  };
  const tests = [
    { src: "alice@", proto: "tcp", accept: [`${target}:18081`], deny: [`${target}:18080`] },
    { src: "alice@", proto: "udp", accept: [`${target}:18080`], deny: [`${target}:18081`] },
    { src: "charlie@", proto: "tcp", deny: [`${target}:18080`, `${target}:18081`] },
  ];
  await expectValid("protocol-specific ACLs", { ...restricted, tests });
  await expectAccessMismatch("dropping proto", {
    acls: restricted.acls.map(({ action, src, dst }) => ({ action, src, dst })),
    tests,
  });
  await expectValid("designer round trip", {
    ...serializePolicy(parsePolicy(JSON.stringify(restricted))),
    tests,
  });
  const hujson = `{
    // Different protocols intentionally use different ports.
    "acls": [
      { "action": "accept", "src": ["alice@",], "dst": ["${target}:18080",], "proto": "udp", },
      { "action": "accept", "src": ["alice@"], "dst": ["${target}:18081"], "proto": "tcp", },
    ],
  }`;
  await expectValid("HuJSON round trip", { ...serializePolicy(parsePolicy(hujson)), tests });
});

test("a grants-only policy survives the designer round trip, an injected allow-all does not", async () => {
  const grantsOnly = { grants: [{ src: ["alice@"], dst: [target], ip: ["tcp:18080"] }] };
  const tests = [
    { src: "alice@", proto: "tcp", accept: [`${target}:18080`], deny: [`${target}:18081`] },
    { src: "charlie@", proto: "tcp", deny: [`${target}:18080`, `${target}:18081`] },
    { src: "192.0.2.10", proto: "tcp", deny: [`${target}:18080`, `${target}:18081`] },
  ];
  await expectValid("grants-only", { ...grantsOnly, tests });
  await expectAccessMismatch("injected allow-all ACL", {
    ...grantsOnly,
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    tests,
  });
  const roundTrip = serializePolicy(parsePolicy(JSON.stringify(grantsOnly)));
  // Compare transmitted values; the HuJSON parser uses prototype-free objects.
  // `?? null` keeps a dropped section a readable assertion failure instead of a JSON.parse crash.
  expect(JSON.parse(JSON.stringify(roundTrip.grants ?? null))).toEqual(grantsOnly.grants);
  expect(roundTrip.acls).toEqual([]);
  await expectValid("grants-only round trip", { ...roundTrip, tests });
});
