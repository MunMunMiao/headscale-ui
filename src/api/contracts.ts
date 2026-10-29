import { type Infer, struct } from "@defjs/core";

// Headscale's protobuf JSON allows absent/null optional fields and retains server extensions.
const extensions = struct.record(struct.unknown().nullish());
const optionalString = struct.string().nullish();
const optionalStrings = struct.array(struct.string()).nullish();

export const headscaleUser = struct.intersection(
  struct.object({
    id: struct.string(),
    name: struct.string(),
    createdAt: optionalString,
    displayName: optionalString,
    email: optionalString,
    providerId: optionalString,
    provider: optionalString,
    profilePicUrl: optionalString,
  }),
  extensions,
);

export const preAuthKey = struct.intersection(
  struct.object({
    id: struct.string(),
    key: struct.string(),
    user: headscaleUser.nullish(),
    reusable: struct.boolean().nullish(),
    ephemeral: struct.boolean().nullish(),
    used: struct.boolean().nullish(),
    expiration: optionalString,
    createdAt: optionalString,
    aclTags: optionalStrings,
  }),
  extensions,
);

export const headscaleNode = struct.intersection(
  struct.object({
    id: struct.string(),
    name: struct.string(),
    machineKey: optionalString,
    nodeKey: optionalString,
    discoKey: optionalString,
    ipAddresses: optionalStrings,
    user: headscaleUser.nullish(),
    lastSeen: optionalString,
    expiry: optionalString,
    preAuthKey: preAuthKey.nullish(),
    createdAt: optionalString,
    registerMethod: optionalString,
    givenName: optionalString,
    online: struct.boolean().nullish(),
    approvedRoutes: optionalStrings,
    availableRoutes: optionalStrings,
    subnetRoutes: optionalStrings,
    tags: optionalStrings,
  }),
  extensions,
);

export const apiKey = struct.intersection(
  struct.object({
    id: struct.string(),
    prefix: struct.string(),
    expiration: optionalString,
    createdAt: optionalString,
    lastSeen: optionalString,
  }),
  extensions,
);

export const rpcStatus = struct.intersection(
  struct.object({
    code: struct.number().optional(),
    message: struct.string().optional(),
    details: struct
      .array(
        struct.intersection(
          struct.object({ "@type": struct.string().optional() }),
          extensions,
        ),
      )
      .nullish(),
  }),
  extensions,
);

export const healthResponse = struct.intersection(
  struct.object({ databaseConnectivity: struct.boolean() }),
  extensions,
);
export const versionResponse = struct.intersection(
  struct.object({ version: struct.string() }),
  extensions,
);
export const usersResponse = struct.intersection(
  struct.object({ users: struct.array(headscaleUser).nullish() }),
  extensions,
);
export const userResponse = struct.intersection(
  struct.object({ user: headscaleUser }),
  extensions,
);
export const preAuthKeysResponse = struct.intersection(
  struct.object({ preAuthKeys: struct.array(preAuthKey).nullish() }),
  extensions,
);
export const preAuthKeyResponse = struct.intersection(
  struct.object({ preAuthKey }),
  extensions,
);
export const nodesResponse = struct.intersection(
  struct.object({ nodes: struct.array(headscaleNode).nullish() }),
  extensions,
);
export const nodeResponse = struct.intersection(
  struct.object({ node: headscaleNode }),
  extensions,
);
export const changesResponse = struct.intersection(
  struct.object({ changes: optionalStrings }),
  extensions,
);
export const apiKeysResponse = struct.intersection(
  struct.object({ apiKeys: struct.array(apiKey).nullish() }),
  extensions,
);
export const createApiKeyResponse = struct.intersection(
  struct.object({ apiKey: struct.string() }),
  extensions,
);
export const policyResponse = struct.intersection(
  struct.object({ policy: struct.string(), updatedAt: optionalString }),
  extensions,
);

// Headscale sends Go's zero time for "never"; an unparseable value is left for formatDate to show raw.
const ZERO_TIME = Date.parse("0001-01-01T00:00:00Z");
function unsetAsUndefined(value?: string | null): string | undefined {
  return !value || Date.parse(value) <= ZERO_TIME ? undefined : value;
}

export function normalizePreAuthKey(key: Infer<typeof preAuthKey>) {
  // Optional in the type: the key stays absent-or-string, never a required `undefined` slot.
  const dates: { expiration?: string } = {
    expiration: unsetAsUndefined(key.expiration),
  };
  return {
    ...key,
    ...dates,
    reusable: key.reusable ?? false,
    ephemeral: key.ephemeral ?? false,
    used: key.used ?? false,
    aclTags: key.aclTags ?? [],
  };
}

export function normalizeHeadscaleNode(node: Infer<typeof headscaleNode>) {
  const { preAuthKey, ...rest } = node;
  const dates: { expiry?: string; lastSeen?: string } = {
    expiry: unsetAsUndefined(node.expiry),
    lastSeen: unsetAsUndefined(node.lastSeen),
  };
  return {
    ...rest,
    ...dates,
    ...(preAuthKey == null
      ? {}
      : { preAuthKey: normalizePreAuthKey(preAuthKey) }),
    ipAddresses: node.ipAddresses ?? [],
    online: node.online ?? false,
    approvedRoutes: node.approvedRoutes ?? [],
    availableRoutes: node.availableRoutes ?? [],
    subnetRoutes: node.subnetRoutes ?? [],
    tags: node.tags ?? [],
  };
}

export type HeadscaleUser = Infer<typeof headscaleUser>;
export type PreAuthKey = ReturnType<typeof normalizePreAuthKey>;
export type HeadscaleNode = ReturnType<typeof normalizeHeadscaleNode>;
export type ApiKey = Infer<typeof apiKey>;

export type HealthResponse = Infer<typeof healthResponse> & {
  checkedAt?: string;
  latencyMs?: number;
  serverReachable?: boolean;
};
export type VersionResponse = Infer<typeof versionResponse>;
export type PolicyResponse = Infer<typeof policyResponse>;
// Client annotation (not a server field): Headscale runs in file mode without a policy path.
export type PolicyReading = PolicyResponse & { fileModeWithoutPath?: true };

export interface HeadscaleSnapshot {
  health: HealthResponse | null;
  version: VersionResponse | null;
  users: HeadscaleUser[];
  preAuthKeys: PreAuthKey[];
  nodes: HeadscaleNode[];
  apiKeys: ApiKey[];
  policy: PolicyReading | null;
}
