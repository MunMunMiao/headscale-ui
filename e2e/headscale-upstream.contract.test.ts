import { expect, test } from "vitest";
import * as endpoints from "../src/api/requests";
import { isPolicyIdentityName } from "../src/domain/policy-designer";
import {
  diffRoutes,
  HEADSCALE_UPSTREAM_VERSION,
  routeKey,
  swaggerRoutes,
  UPSTREAM_RPCS,
} from "./headscale-upstream";

const baseUrl = process.env.HEADSCALE_E2E_URL?.replace(/\/$/, "");
const apiKey = process.env.HEADSCALE_E2E_API_KEY ?? process.env.VITE_HEADSCALE_E2E_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error("HEADSCALE_E2E_URL and HEADSCALE_E2E_API_KEY are required");
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

function message(json: unknown) {
  return json !== null && typeof json === "object" && "message" in json ? String(json.message) : "";
}

// Never use an SSH check id here: handing one to auth.register is unverified and may crash Headscale.
const unknownAuthId = `hskey-authreq-${"0".repeat(24)}`;

test("the pinned upstream route table matches the live gateway", async () => {
  const pinned = UPSTREAM_RPCS.map(({ method, path }) => routeKey(method, path)).sort();
  const response = await call("GET", "/swagger/v1/openapiv2.json");
  if (response.status !== 200 || response.json === undefined) {
    // UNVERIFIED: the swagger route is unavailable or protected; only the pin and the compose tag guard apply.
    console.warn(
      `[upstream] swagger unavailable (HTTP ${response.status}); route table UNVERIFIED`,
    );
    return;
  }
  const live = swaggerRoutes(response.json);
  expect(live.map(({ method, path }) => routeKey(method, path)).sort()).toEqual(pinned);
  expect(diffRoutes(live, endpoints)).toEqual([]);
});

test("the server reports the pinned Headscale version", async () => {
  const response = await call("GET", "/version");
  expect(response.status).toBe(200);
  expect(response.text).toContain(HEADSCALE_UPSTREAM_VERSION);
});

test("auth request RPCs report malformed and unknown ids with a JSON status", async () => {
  const malformed = await call("POST", "/api/v1/auth/approve", { authId: "not-an-auth-id" });
  expect(malformed.status).toBe(400);
  expect(message(malformed.json)).toContain("invalid auth_id");
  for (const action of ["approve", "reject"]) {
    const unknown = await call("POST", `/api/v1/auth/${action}`, { authId: unknownAuthId });
    expect(unknown.status).toBe(404);
    expect(message(unknown.json)).toContain("no pending auth session");
  }
  const register = await call("POST", "/api/v1/auth/register", {
    user: "nobody-here",
    authId: unknownAuthId,
  });
  expect(register.status).toBeGreaterThanOrEqual(400);
  expect(message(register.json)).not.toBe("");
});

test("policy.check validates without persisting anything", async () => {
  const before = await call("GET", "/api/v1/policy");
  const accept = [{ action: "accept", src: ["*"], dst: ["*:*"] }];

  const valid = await call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({ acls: accept }),
  });
  expect(valid.status).toBe(200);
  expect(valid.json).toEqual({});

  // Headscale 0.29.4 accepts references to users that do not exist yet.
  const unknownUser = await call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({ acls: [{ action: "accept", src: ["nobody-here@"], dst: ["*:*"] }] }),
  });
  expect(unknownUser.status).toBe(200);

  const undefinedGroup = await call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({ acls: [{ action: "accept", src: ["group:nope"], dst: ["*:*"] }] }),
  });
  expect(undefinedGroup.status).toBe(400);
  expect(message(undefinedGroup.json)).toMatch(/group not defined/);

  const empty = await call("POST", "/api/v1/policy/check", { policy: "" });
  expect(empty.status).toBe(200);
  const failing = await call("POST", "/api/v1/policy/check", {
    policy: JSON.stringify({
      acls: accept,
      tests: [{ src: "100.64.0.1", deny: ["100.64.0.2:80"] }],
    }),
  });
  expect(failing.status).toBe(400);
  expect(message(failing.json)).toMatch(/test\(s\) failed/);

  expect((await call("GET", "/api/v1/policy")).text).toBe(before.text);
});

// A predicate that accepts a name must imply the server accepts it. Names with whitespace, ',', '@' or ':'
// are deliberate UI-only exclusions and are not asserted here.
test("policy.check accepts the tag names the editor accepts", async () => {
  const check = (tag: string) =>
    call("POST", "/api/v1/policy/check", {
      policy: JSON.stringify({
        tagOwners: { [tag]: ["nobody-here@"] },
        acls: [{ action: "accept", src: ["*"], dst: [`${tag}:22`] }],
      }),
    });
  for (const tag of ["tag:k8s_node", "tag:ci.runner-2", "tag:Web1"]) {
    expect(isPolicyIdentityName(tag, "tag"), tag).toBe(true);
    expect((await check(tag)).status, tag).toBe(200);
  }
  for (const tag of ["tag:1abc", "tag:", "tag:-x"]) {
    expect(isPolicyIdentityName(tag, "tag"), tag).toBe(false);
    expect((await check(tag)).status, tag).toBeGreaterThanOrEqual(400);
  }
});

// MEASUREMENT: the camelCase `disableExpiry` query binding and its exclusion with `expiry` on the gateway.
// The browser lane resets the fixture; this test still restores node 3 to its original expired state.
test("node.expire?disableExpiry=true clears the expiry and rejects a simultaneous expiry", async () => {
  const nodeId = "3";
  const expiry = async () => {
    const node = await call("GET", `/api/v1/node/${nodeId}`);
    expect(node.status).toBe(200);
    return (node.json as { node?: { expiry?: string } }).node?.expiry;
  };
  // Zero-value timestamps count as "no expiry" for the UI; Date.parse(0001-01-01) is a large negative number.
  const isUnset = (value?: string) => !value || value.startsWith("0001-");
  const original = await expiry();
  expect(isUnset(original), "the fixture phone must start expired").toBe(false);
  try {
    const both = await call(
      "POST",
      `/api/v1/node/${nodeId}/expire?disableExpiry=true&expiry=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`,
    );
    expect(both.status).toBe(400);
    expect(message(both.json)).not.toBe("");
    expect(await expiry()).toBe(original);

    const disabled = await call("POST", `/api/v1/node/${nodeId}/expire?disableExpiry=true`);
    expect(disabled.status).toBe(200);
    expect(isUnset(await expiry())).toBe(true);
  } finally {
    // Re-expire so later suites see the original fixture shape (expired now, server-stamped).
    expect((await call("POST", `/api/v1/node/${nodeId}/expire`)).status).toBe(200);
  }
  expect(Date.parse((await expiry()) ?? "")).toBeLessThanOrEqual(Date.now() + 5_000);
});

// MEASUREMENT: a tags-only pre-auth key without an owner is accepted and the owner field stays empty.
test("preauthkey.create accepts an owner-less tagged key and rejects one with neither owner nor tags", async () => {
  const expiration = new Date(Date.now() + 86_400_000).toISOString();
  const created = await call("POST", "/api/v1/preauthkey", {
    expiration,
    aclTags: ["tag:server"],
  });
  try {
    expect(created.status).toBe(200);
    const key = (
      created.json as { preAuthKey?: { id?: string; user?: unknown; aclTags?: string[] } }
    ).preAuthKey;
    expect(key?.aclTags).toEqual(["tag:server"]);
    expect(key?.user ?? null).toBeNull();
  } finally {
    const id = (created.json as { preAuthKey?: { id?: string } } | undefined)?.preAuthKey?.id;
    if (id) expect((await call("DELETE", `/api/v1/preauthkey?id=${id}`)).status).toBe(200);
  }

  const neither = await call("POST", "/api/v1/preauthkey", { expiration });
  expect(neither.status).toBeGreaterThanOrEqual(400);
  expect(message(neither.json)).not.toBe("");
});
