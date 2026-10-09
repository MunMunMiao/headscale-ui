export type OperationGroup =
  | "connection"
  | "users"
  | "preauthkeys"
  | "nodes"
  | "routes"
  | "apikeys"
  | "policy";

export type OperationFieldType = "text" | "datetime" | "checkbox" | "list";

export interface OperationField {
  name: string;
  label: string;
  type: OperationFieldType;
  placeholder?: string;
  defaultValue?: string | boolean;
  helper?: string;
}

export interface HeadscaleOperation {
  id: string;
  group: OperationGroup;
  title: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  coverage: "rest-api" | "server";
  fields: OperationField[];
}

export const HEADSCALE_OPERATIONS = [
  {
    id: "health.check",
    group: "connection",
    title: "Check health",
    description: "Read Headscale database connectivity from the server health endpoint.",
    method: "GET",
    path: "/api/v1/health",
    coverage: "rest-api",
    fields: [],
  },
  {
    id: "version.get",
    group: "connection",
    title: "Read version",
    description: "Read the Headscale server version.",
    method: "GET",
    path: "/version",
    coverage: "server",
    fields: [],
  },
  {
    id: "user.list",
    group: "users",
    title: "Query users",
    description: "Filter by id, name or email; leave empty to list all users.",
    method: "GET",
    path: "/api/v1/user",
    coverage: "rest-api",
    fields: [
      { name: "id", label: "User ID", type: "text", placeholder: "1" },
      { name: "name", label: "User name", type: "text", placeholder: "alice" },
      { name: "email", label: "Email", type: "text", placeholder: "alice@example.com" },
    ],
  },
  {
    id: "user.create",
    group: "users",
    title: "Create user",
    description: "Create a tailnet user with optional display name, email and avatar.",
    method: "POST",
    path: "/api/v1/user",
    coverage: "rest-api",
    fields: [
      { name: "name", label: "User name", type: "text", defaultValue: "alice" },
      { name: "displayName", label: "Display name", type: "text", defaultValue: "Alice Ops" },
      { name: "email", label: "Email", type: "text", defaultValue: "alice@example.com" },
      { name: "pictureUrl", label: "Picture URL", type: "text", placeholder: "https://..." },
    ],
  },
  {
    id: "user.rename",
    group: "users",
    title: "Rename user",
    description: "Rename a user by numeric user ID.",
    method: "POST",
    path: "/api/v1/user/{old_id}/rename/{new_name}",
    coverage: "rest-api",
    fields: [
      { name: "id", label: "User ID", type: "text", defaultValue: "1" },
      { name: "newName", label: "New user name", type: "text", defaultValue: "alice-admin" },
    ],
  },
  {
    id: "user.delete",
    group: "users",
    title: "Delete user",
    description: "Delete the selected user.",
    method: "DELETE",
    path: "/api/v1/user/{id}",
    coverage: "rest-api",
    fields: [{ name: "id", label: "User ID", type: "text", defaultValue: "3" }],
  },
  {
    id: "preauthkey.list",
    group: "preauthkeys",
    title: "List pre-auth keys",
    description: "List all pre-authentication keys.",
    method: "GET",
    path: "/api/v1/preauthkey",
    coverage: "rest-api",
    fields: [],
  },
  {
    id: "preauthkey.create",
    group: "preauthkeys",
    title: "Create pre-auth key",
    description: "Create an auth key for personal or tagged devices.",
    method: "POST",
    path: "/api/v1/preauthkey",
    coverage: "rest-api",
    fields: [
      { name: "user", label: "User ID", type: "text", defaultValue: "1" },
      { name: "reusable", label: "Reusable", type: "checkbox", defaultValue: true },
      { name: "ephemeral", label: "Ephemeral node", type: "checkbox", defaultValue: false },
      {
        name: "expiration",
        label: "Expiration",
        type: "datetime",
        defaultValue: "2026-12-31T23:59:00Z",
      },
      {
        name: "aclTags",
        label: "ACL tags",
        type: "list",
        defaultValue: "tag:server",
        helper: "Comma or newline separated",
      },
    ],
  },
  {
    id: "preauthkey.expire",
    group: "preauthkeys",
    title: "Expire pre-auth key",
    description: "Expire a pre-authentication key by ID.",
    method: "POST",
    path: "/api/v1/preauthkey/expire",
    coverage: "rest-api",
    fields: [{ name: "id", label: "Key ID", type: "text", defaultValue: "1" }],
  },
  {
    id: "preauthkey.delete",
    group: "preauthkeys",
    title: "Delete pre-auth key",
    description: "Delete a pre-authentication key by ID.",
    method: "DELETE",
    path: "/api/v1/preauthkey?id={id}",
    coverage: "rest-api",
    fields: [{ name: "id", label: "Key ID", type: "text", defaultValue: "2" }],
  },
  {
    id: "node.list",
    group: "nodes",
    title: "List nodes",
    description: "List all nodes, optionally filtered by user.",
    method: "GET",
    path: "/api/v1/node",
    coverage: "rest-api",
    fields: [{ name: "user", label: "User filter", type: "text", placeholder: "1 or alice" }],
  },
  {
    id: "node.get",
    group: "nodes",
    title: "Read node details",
    description: "Fetch a full node record by node ID.",
    method: "GET",
    path: "/api/v1/node/{node_id}",
    coverage: "rest-api",
    fields: [{ name: "nodeId", label: "Node ID", type: "text", defaultValue: "1" }],
  },
  {
    id: "node.register",
    group: "nodes",
    title: "Register pending node",
    description: "Approve and register a node with a registration key.",
    method: "POST",
    path: "/api/v1/node/register",
    coverage: "rest-api",
    fields: [
      { name: "user", label: "Username", type: "text", defaultValue: "alice" },
      {
        name: "key",
        label: "Registration Key",
        type: "text",
        defaultValue: "",
      },
    ],
  },
  {
    id: "node.debugCreate",
    group: "nodes",
    title: "Debug create node",
    description: "Create a test node through Headscale's debug endpoint.",
    method: "POST",
    path: "/api/v1/debug/node",
    coverage: "rest-api",
    fields: [
      { name: "user", label: "Username", type: "text", defaultValue: "alice" },
      { name: "key", label: "Node key", type: "text", defaultValue: "" },
      { name: "name", label: "Node name", type: "text", defaultValue: "debug-router" },
      { name: "routes", label: "Advertised routes", type: "list", defaultValue: "10.10.0.0/16" },
    ],
  },
  {
    id: "node.rename",
    group: "nodes",
    title: "Rename node",
    description: "Change a node's given name.",
    method: "POST",
    path: "/api/v1/node/{node_id}/rename/{new_name}",
    coverage: "rest-api",
    fields: [
      { name: "nodeId", label: "Node ID", type: "text", defaultValue: "1" },
      { name: "newName", label: "New name", type: "text", defaultValue: "laptop-main" },
    ],
  },
  {
    id: "node.expire",
    group: "nodes",
    title: "Expire node",
    description: "Expire a node now or at a specified time.",
    method: "POST",
    path: "/api/v1/node/{node_id}/expire",
    coverage: "rest-api",
    fields: [
      { name: "nodeId", label: "Node ID", type: "text", defaultValue: "2" },
      {
        name: "expiry",
        label: "Expiration",
        type: "datetime",
        defaultValue: "2026-12-31T23:59:00Z",
      },
      {
        name: "disableExpiry",
        label: "Disable expiry",
        type: "checkbox",
        defaultValue: false,
        helper: "Latest Headscale can clear node expiry with this flag.",
      },
    ],
  },
  {
    id: "node.delete",
    group: "nodes",
    title: "Delete node",
    description: "Remove a node from the tailnet.",
    method: "DELETE",
    path: "/api/v1/node/{node_id}",
    coverage: "rest-api",
    fields: [{ name: "nodeId", label: "Node ID", type: "text", defaultValue: "3" }],
  },
  {
    id: "node.setTags",
    group: "nodes",
    title: "Set node tags",
    description: "Replace the node's current tags.",
    method: "POST",
    path: "/api/v1/node/{node_id}/tags",
    coverage: "rest-api",
    fields: [
      { name: "nodeId", label: "Node ID", type: "text", defaultValue: "1" },
      { name: "tags", label: "Tags", type: "list", defaultValue: "tag:workstation" },
    ],
  },
  {
    id: "node.setApprovedRoutes",
    group: "routes",
    title: "Approve node routes",
    description: "Replace approved routes, including subnet and exit-node routes.",
    method: "POST",
    path: "/api/v1/node/{node_id}/approve_routes",
    coverage: "rest-api",
    fields: [
      { name: "nodeId", label: "Node ID", type: "text", defaultValue: "2" },
      {
        name: "routes",
        label: "Approved routes",
        type: "list",
        defaultValue: "10.42.0.0/16,0.0.0.0/0,::/0",
      },
    ],
  },
  {
    id: "node.backfillIps",
    group: "nodes",
    title: "Backfill node IPs",
    description: "Run the Headscale node IP backfill maintenance action.",
    method: "POST",
    path: "/api/v1/node/backfillips",
    coverage: "rest-api",
    fields: [
      { name: "confirmed", label: "Confirm execution", type: "checkbox", defaultValue: true },
    ],
  },
  {
    id: "apikey.list",
    group: "apikeys",
    title: "List API keys",
    description: "List server API key metadata.",
    method: "GET",
    path: "/api/v1/apikey",
    coverage: "rest-api",
    fields: [],
  },
  {
    id: "apikey.create",
    group: "apikeys",
    title: "Create API key",
    description: "Create a new API key; the full value is returned once.",
    method: "POST",
    path: "/api/v1/apikey",
    coverage: "rest-api",
    fields: [
      {
        name: "expiration",
        label: "Expiration",
        type: "datetime",
        defaultValue: "2026-12-31T23:59:00Z",
      },
    ],
  },
  {
    id: "apikey.expire",
    group: "apikeys",
    title: "Expire API key",
    description: "Expire an API key by prefix or ID.",
    method: "POST",
    path: "/api/v1/apikey/expire",
    coverage: "rest-api",
    fields: [
      { name: "prefix", label: "Prefix", type: "text", defaultValue: "" },
      { name: "id", label: "ID", type: "text", placeholder: "Optional" },
    ],
  },
  {
    id: "apikey.delete",
    group: "apikeys",
    title: "Delete API key",
    description: "Delete an API key by prefix.",
    method: "DELETE",
    path: "/api/v1/apikey/{prefix}",
    coverage: "rest-api",
    fields: [{ name: "prefix", label: "Prefix", type: "text", defaultValue: "" }],
  },
  {
    id: "policy.get",
    group: "policy",
    title: "Read Policy/ACL",
    description: "Read the Headscale policy content and update timestamp.",
    method: "GET",
    path: "/api/v1/policy",
    coverage: "rest-api",
    fields: [],
  },
  {
    id: "policy.set",
    group: "policy",
    title: "Save Policy/ACL",
    description: "Save the policy generated by the visual ACL, group and tag-owner designer.",
    method: "PUT",
    path: "/api/v1/policy",
    coverage: "rest-api",
    fields: [],
  },
] as const satisfies readonly HeadscaleOperation[];

export type OperationId = (typeof HEADSCALE_OPERATIONS)[number]["id"];

export const OPERATION_IDS = HEADSCALE_OPERATIONS.map((operation) => operation.id);
