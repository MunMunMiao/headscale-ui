import assert from "node:assert/strict";

export function parseCsp(value: string | null): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of (value || "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources.join(" "));
  }
  return directives;
}

export function assertSecurityHeaders(
  response: Pick<Response, "headers">,
  label: string,
  connect = "'self'",
) {
  const csp = parseCsp(response.headers.get("content-security-policy"));
  const expected: Record<string, string> = {
    "script-src": "'self'",
    "worker-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'self'",
    "frame-ancestors": "'none'",
    "connect-src": connect,
  };
  for (const [directive, sources] of Object.entries(expected)) {
    assert.equal(csp.get(directive), sources, `${label}: CSP ${directive}`);
  }
  assert.equal(response.headers.get("x-frame-options"), "DENY", `${label}: X-Frame-Options`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label}: nosniff`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${label}: Referrer-Policy`);
}
