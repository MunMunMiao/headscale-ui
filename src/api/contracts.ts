import { type Infer, struct } from "@defjs/core";

// Headscale's protobuf JSON allows absent/null optional fields and retains server extensions.
const extensions = struct.record(struct.unknown().nullish());
const optionalString = struct.string().nullish();
const optionalStrings = struct.array(struct.string()).nullish();

export const HeadscaleUser = struct.intersection(
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
export type HeadscaleUser = Infer<typeof HeadscaleUser>;

export const PreAuthKeyData = struct.intersection(
  struct.object({
    id: struct.string(),
    key: struct.string(),
    user: HeadscaleUser.nullish(),
    reusable: struct.boolean().nullish(),
    ephemeral: struct.boolean().nullish(),
    used: struct.boolean().nullish(),
    expiration: optionalString,
    createdAt: optionalString,
    aclTags: optionalStrings,
  }),
  extensions,
);
export type PreAuthKeyData = Infer<typeof PreAuthKeyData>;

export const HeadscaleNodeData = struct.intersection(
  struct.object({
    id: struct.string(),
    name: struct.string(),
    machineKey: optionalString,
    nodeKey: optionalString,
    discoKey: optionalString,
    ipAddresses: optionalStrings,
    user: HeadscaleUser.nullish(),
    lastSeen: optionalString,
    expiry: optionalString,
    preAuthKey: PreAuthKeyData.nullish(),
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
export type HeadscaleNodeData = Infer<typeof HeadscaleNodeData>;

export const ApiKey = struct.intersection(
  struct.object({
    id: struct.string(),
    prefix: struct.string(),
    expiration: optionalString,
    createdAt: optionalString,
    lastSeen: optionalString,
  }),
  extensions,
);
export type ApiKey = Infer<typeof ApiKey>;

export const RpcStatus = struct.intersection(
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
export type RpcStatus = Infer<typeof RpcStatus>;

export const HealthPayload = struct.intersection(
  struct.object({ databaseConnectivity: struct.boolean() }),
  extensions,
);
export type HealthPayload = Infer<typeof HealthPayload>;

export const VersionResponse = struct.intersection(
  struct.object({ version: struct.string() }),
  extensions,
);
export type VersionResponse = Infer<typeof VersionResponse>;

export const UsersResponse = struct.intersection(
  struct.object({ users: struct.array(HeadscaleUser).nullish() }),
  extensions,
);
export type UsersResponse = Infer<typeof UsersResponse>;

export const UserResponse = struct.intersection(
  struct.object({ user: HeadscaleUser }),
  extensions,
);
export type UserResponse = Infer<typeof UserResponse>;

export const PreAuthKeysResponse = struct.intersection(
  struct.object({ preAuthKeys: struct.array(PreAuthKeyData).nullish() }),
  extensions,
);
export type PreAuthKeysResponse = Infer<typeof PreAuthKeysResponse>;

export const PreAuthKeyResponse = struct.intersection(
  struct.object({ preAuthKey: PreAuthKeyData }),
  extensions,
);
export type PreAuthKeyResponse = Infer<typeof PreAuthKeyResponse>;

export const NodesResponse = struct.intersection(
  struct.object({ nodes: struct.array(HeadscaleNodeData).nullish() }),
  extensions,
);
export type NodesResponse = Infer<typeof NodesResponse>;

export const NodeResponse = struct.intersection(
  struct.object({ node: HeadscaleNodeData }),
  extensions,
);
export type NodeResponse = Infer<typeof NodeResponse>;

export const ChangesResponse = struct.intersection(
  struct.object({ changes: optionalStrings }),
  extensions,
);
export type ChangesResponse = Infer<typeof ChangesResponse>;

export const ApiKeysResponse = struct.intersection(
  struct.object({ apiKeys: struct.array(ApiKey).nullish() }),
  extensions,
);
export type ApiKeysResponse = Infer<typeof ApiKeysResponse>;

export const CreateApiKeyResponse = struct.intersection(
  struct.object({ apiKey: struct.string() }),
  extensions,
);
export type CreateApiKeyResponse = Infer<typeof CreateApiKeyResponse>;

export const PolicyResponse = struct.intersection(
  struct.object({ policy: struct.string(), updatedAt: optionalString }),
  extensions,
);
export type PolicyResponse = Infer<typeof PolicyResponse>;

// Headscale sends Go's zero time for "never"; an unparseable value is left for formatDate to show raw.
const ZERO_TIME = Date.parse("0001-01-01T00:00:00Z");
function unsetAsUndefined(value?: string | null): string | undefined {
  return !value || Date.parse(value) <= ZERO_TIME ? undefined : value;
}

export function normalizePreAuthKey(key: PreAuthKeyData) {
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

export function normalizeHeadscaleNode(node: HeadscaleNodeData) {
  const { preAuthKey: nodePreAuthKey, ...rest } = node;
  const dates: { expiry?: string; lastSeen?: string } = {
    expiry: unsetAsUndefined(node.expiry),
    lastSeen: unsetAsUndefined(node.lastSeen),
  };
  return {
    ...rest,
    ...dates,
    ...(nodePreAuthKey == null
      ? {}
      : { preAuthKey: normalizePreAuthKey(nodePreAuthKey) }),
    ipAddresses: node.ipAddresses ?? [],
    online: node.online ?? false,
    approvedRoutes: node.approvedRoutes ?? [],
    availableRoutes: node.availableRoutes ?? [],
    subnetRoutes: node.subnetRoutes ?? [],
    tags: node.tags ?? [],
  };
}

export type PreAuthKey = ReturnType<typeof normalizePreAuthKey>;
export type HeadscaleNode = ReturnType<typeof normalizeHeadscaleNode>;

export type HealthResponse = HealthPayload & {
  checkedAt?: string;
  latencyMs?: number;
  serverReachable?: boolean;
};
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
