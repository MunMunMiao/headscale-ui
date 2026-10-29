/** The defjs `operation` of each request in src/api/requests.ts, matched here by method and path. */
export type OperationId = (typeof operations)[number][0];

export interface NetworkOperationCall {
  id: OperationId;
  method: string;
  url: string;
  payload?: {
    policy?: string;
    routes?: string[];
    expiration?: string;
    confirmed?: boolean;
  };
}

const operations = [
  ["health.check", "GET", /^\/api\/v1\/health$/],
  ["version.get", "GET", /^\/version$/],
  ["user.list", "GET", /^\/api\/v1\/user$/],
  ["user.create", "POST", /^\/api\/v1\/user$/],
  ["user.rename", "POST", /^\/api\/v1\/user\/[^/]+\/rename\/[^/]+$/],
  ["user.delete", "DELETE", /^\/api\/v1\/user\/[^/]+$/],
  ["preauthkey.list", "GET", /^\/api\/v1\/preauthkey$/],
  ["preauthkey.create", "POST", /^\/api\/v1\/preauthkey$/],
  ["preauthkey.expire", "POST", /^\/api\/v1\/preauthkey\/expire$/],
  ["preauthkey.delete", "DELETE", /^\/api\/v1\/preauthkey$/],
  ["node.list", "GET", /^\/api\/v1\/node$/],
  ["node.get", "GET", /^\/api\/v1\/node\/\d+$/],
  ["node.register", "POST", /^\/api\/v1\/node\/register$/],
  ["node.debugCreate", "POST", /^\/api\/v1\/debug\/node$/],
  ["node.rename", "POST", /^\/api\/v1\/node\/[^/]+\/rename\/[^/]+$/],
  ["node.expire", "POST", /^\/api\/v1\/node\/[^/]+\/expire$/],
  ["node.delete", "DELETE", /^\/api\/v1\/node\/[^/]+$/],
  ["node.setTags", "POST", /^\/api\/v1\/node\/[^/]+\/tags$/],
  [
    "node.setApprovedRoutes",
    "POST",
    /^\/api\/v1\/node\/[^/]+\/approve_routes$/,
  ],
  ["node.backfillIps", "POST", /^\/api\/v1\/node\/backfillips$/],
  ["auth.register", "POST", /^\/api\/v1\/auth\/register$/],
  ["auth.approve", "POST", /^\/api\/v1\/auth\/approve$/],
  ["auth.reject", "POST", /^\/api\/v1\/auth\/reject$/],
  ["apikey.list", "GET", /^\/api\/v1\/apikey$/],
  ["apikey.create", "POST", /^\/api\/v1\/apikey$/],
  ["apikey.expire", "POST", /^\/api\/v1\/apikey\/expire$/],
  ["apikey.delete", "DELETE", /^\/api\/v1\/apikey\/[^/]+$/],
  ["policy.get", "GET", /^\/api\/v1\/policy$/],
  ["policy.set", "PUT", /^\/api\/v1\/policy$/],
  ["policy.check", "POST", /^\/api\/v1\/policy\/check$/],
] as const;

export function networkOperation(
  method: string,
  path: string,
): NetworkOperationCall | undefined {
  const operation = operations.find(
    ([, verb, pattern]) => method === verb && pattern.test(path),
  );
  return operation ? { id: operation[0], method, url: path } : undefined;
}

export async function readOperationPayload(
  request: Request,
  id: OperationId,
): Promise<NetworkOperationCall["payload"]> {
  // Only the boolean leaves the query string; other query values may carry credentials.
  if (id === "node.backfillIps")
    return {
      confirmed: new URL(request.url).searchParams.get("confirmed") === "true",
    };
  if (
    id !== "policy.set" &&
    id !== "node.setApprovedRoutes" &&
    id !== "preauthkey.create"
  )
    return undefined;
  try {
    const body: unknown = await request.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return undefined;
    if (
      id === "policy.set" &&
      "policy" in body &&
      typeof body.policy === "string"
    )
      return { policy: body.policy };
    if (
      id === "node.setApprovedRoutes" &&
      "routes" in body &&
      Array.isArray(body.routes) &&
      body.routes.every((route) => typeof route === "string")
    )
      return { routes: body.routes };
    if (
      id === "preauthkey.create" &&
      "expiration" in body &&
      typeof body.expiration === "string"
    )
      return { expiration: body.expiration };
  } catch {
    // Invalid request bodies must reach Headscale unchanged; diagnostics do not validate traffic.
  }
  return undefined;
}
