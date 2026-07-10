import type { AxiosInstance } from "axios";
import type { ConnectionSettings } from "./http";
import { createHeadscaleHttp } from "./http";
import { recordOperationCall } from "./operation-log";
import { parseList } from "./payload";
import type { HeadscaleClient, OperationPayload } from "./types";

function stringValue(payload: OperationPayload, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function booleanValue(payload: OperationPayload, key: string) {
  return payload[key] === true;
}

function listValue(payload: OperationPayload, key: string) {
  return parseList(payload[key]);
}

function paramsFrom(payload: OperationPayload, keys: string[]) {
  const params = new URLSearchParams();

  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      params.set(key, value);
    }
    if (typeof value === "boolean") {
      params.set(key, String(value));
    }
  }

  return params;
}

function withQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class RestHeadscaleClient implements HeadscaleClient {
  private readonly http: AxiosInstance;

  constructor(settings: ConnectionSettings) {
    this.http = createHeadscaleHttp(settings);
  }

  async health() {
    const startedAt = performance.now();
    recordOperationCall("health.check", "GET", "/api/v1/health", {});
    const response = await this.http.get("/api/v1/health");
    return {
      ...response.data,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      serverReachable: true,
    };
  }

  async version() {
    recordOperationCall("version.get", "GET", "/version", {});
    return (await this.http.get("/version")).data;
  }

  async listUsers(payload: OperationPayload) {
    const url = withQuery("/api/v1/user", paramsFrom(payload, ["id", "name", "email"]));
    recordOperationCall("user.list", "GET", url, payload);
    return (await this.http.get(url)).data;
  }

  async createUser(payload: OperationPayload) {
    const body = {
      name: stringValue(payload, "name"),
      displayName: stringValue(payload, "displayName"),
      email: stringValue(payload, "email"),
      pictureUrl: stringValue(payload, "pictureUrl"),
    };
    recordOperationCall("user.create", "POST", "/api/v1/user", body);
    return (await this.http.post("/api/v1/user", body)).data;
  }

  async renameUser(payload: OperationPayload) {
    const url = `/api/v1/user/${stringValue(payload, "id")}/rename/${encodeURIComponent(
      stringValue(payload, "newName"),
    )}`;
    recordOperationCall("user.rename", "POST", url, payload);
    return (await this.http.post(url)).data;
  }

  async deleteUser(payload: OperationPayload) {
    const url = `/api/v1/user/${stringValue(payload, "id")}`;
    recordOperationCall("user.delete", "DELETE", url, payload);
    return (await this.http.delete(url)).data;
  }

  async listPreAuthKeys() {
    recordOperationCall("preauthkey.list", "GET", "/api/v1/preauthkey", {});
    return (await this.http.get("/api/v1/preauthkey")).data;
  }

  async createPreAuthKey(payload: OperationPayload) {
    const body = {
      user: stringValue(payload, "user"),
      reusable: booleanValue(payload, "reusable"),
      ephemeral: booleanValue(payload, "ephemeral"),
      expiration: stringValue(payload, "expiration"),
      aclTags: listValue(payload, "aclTags"),
    };
    recordOperationCall("preauthkey.create", "POST", "/api/v1/preauthkey", body);
    return (await this.http.post("/api/v1/preauthkey", body)).data;
  }

  async expirePreAuthKey(payload: OperationPayload) {
    const body = { id: stringValue(payload, "id") };
    recordOperationCall("preauthkey.expire", "POST", "/api/v1/preauthkey/expire", body);
    return (await this.http.post("/api/v1/preauthkey/expire", body)).data;
  }

  async deletePreAuthKey(payload: OperationPayload) {
    const url = withQuery("/api/v1/preauthkey", paramsFrom(payload, ["id"]));
    recordOperationCall("preauthkey.delete", "DELETE", url, payload);
    return (await this.http.delete(url)).data;
  }

  async listNodes(payload: OperationPayload) {
    const url = withQuery("/api/v1/node", paramsFrom(payload, ["user"]));
    recordOperationCall("node.list", "GET", url, payload);
    return (await this.http.get(url)).data;
  }

  async getNode(payload: OperationPayload) {
    const url = `/api/v1/node/${stringValue(payload, "nodeId")}`;
    recordOperationCall("node.get", "GET", url, payload);
    return (await this.http.get(url)).data;
  }

  async registerNode(payload: OperationPayload) {
    const url = withQuery("/api/v1/node/register", paramsFrom(payload, ["user", "key"]));
    recordOperationCall("node.register", "POST", url, payload);
    return (await this.http.post(url)).data;
  }

  async authRegister(payload: OperationPayload) {
    const body = {
      user: stringValue(payload, "user"),
      authId: stringValue(payload, "authId"),
    };
    recordOperationCall("auth.register", "POST", "/api/v1/auth/register", body);
    return (await this.http.post("/api/v1/auth/register", body)).data;
  }

  async authApprove(payload: OperationPayload) {
    const body = { authId: stringValue(payload, "authId") };
    recordOperationCall("auth.approve", "POST", "/api/v1/auth/approve", body);
    return (await this.http.post("/api/v1/auth/approve", body)).data;
  }

  async authReject(payload: OperationPayload) {
    const body = { authId: stringValue(payload, "authId") };
    recordOperationCall("auth.reject", "POST", "/api/v1/auth/reject", body);
    return (await this.http.post("/api/v1/auth/reject", body)).data;
  }

  async debugCreateNode(payload: OperationPayload) {
    const body = {
      user: stringValue(payload, "user"),
      key: stringValue(payload, "key"),
      name: stringValue(payload, "name"),
      routes: listValue(payload, "routes"),
    };
    recordOperationCall("node.debugCreate", "POST", "/api/v1/debug/node", body);
    return (await this.http.post("/api/v1/debug/node", body)).data;
  }

  async renameNode(payload: OperationPayload) {
    const url = `/api/v1/node/${stringValue(payload, "nodeId")}/rename/${encodeURIComponent(
      stringValue(payload, "newName"),
    )}`;
    recordOperationCall("node.rename", "POST", url, payload);
    return (await this.http.post(url)).data;
  }

  async expireNode(payload: OperationPayload) {
    const url = withQuery(
      `/api/v1/node/${stringValue(payload, "nodeId")}/expire`,
      paramsFrom(payload, ["expiry", "disableExpiry"]),
    );
    recordOperationCall("node.expire", "POST", url, payload);
    return (await this.http.post(url)).data;
  }

  async deleteNode(payload: OperationPayload) {
    const url = `/api/v1/node/${stringValue(payload, "nodeId")}`;
    recordOperationCall("node.delete", "DELETE", url, payload);
    return (await this.http.delete(url)).data;
  }

  async setTags(payload: OperationPayload) {
    const url = `/api/v1/node/${stringValue(payload, "nodeId")}/tags`;
    const body = { tags: listValue(payload, "tags") };
    recordOperationCall("node.setTags", "POST", url, body);
    return (await this.http.post(url, body)).data;
  }

  async setApprovedRoutes(payload: OperationPayload) {
    const url = `/api/v1/node/${stringValue(payload, "nodeId")}/approve_routes`;
    const body = { routes: listValue(payload, "routes") };
    recordOperationCall("node.setApprovedRoutes", "POST", url, body);
    return (await this.http.post(url, body)).data;
  }

  async backfillNodeIps(payload: OperationPayload) {
    const url = withQuery("/api/v1/node/backfillips", paramsFrom(payload, ["confirmed"]));
    recordOperationCall("node.backfillIps", "POST", url, payload);
    return (await this.http.post(url)).data;
  }

  async listApiKeys() {
    recordOperationCall("apikey.list", "GET", "/api/v1/apikey", {});
    return (await this.http.get("/api/v1/apikey")).data;
  }

  async createApiKey(payload: OperationPayload) {
    const body = { expiration: stringValue(payload, "expiration") };
    recordOperationCall("apikey.create", "POST", "/api/v1/apikey", body);
    return (await this.http.post("/api/v1/apikey", body)).data;
  }

  async expireApiKey(payload: OperationPayload) {
    const body = {
      prefix: stringValue(payload, "prefix"),
      id: stringValue(payload, "id"),
    };
    recordOperationCall("apikey.expire", "POST", "/api/v1/apikey/expire", body);
    return (await this.http.post("/api/v1/apikey/expire", body)).data;
  }

  async deleteApiKey(payload: OperationPayload) {
    const url = withQuery(
      `/api/v1/apikey/${encodeURIComponent(stringValue(payload, "prefix"))}`,
      paramsFrom(payload, ["id"]),
    );
    recordOperationCall("apikey.delete", "DELETE", url, payload);
    return (await this.http.delete(url)).data;
  }

  async getPolicy() {
    recordOperationCall("policy.get", "GET", "/api/v1/policy", {});
    try {
      return (await this.http.get("/api/v1/policy")).data;
    } catch (error) {
      if (error instanceof Error && /acl\s+policy not found/i.test(error.message)) {
        return { policy: "" };
      }
      throw error;
    }
  }

  async setPolicy(payload: OperationPayload) {
    const body = { policy: stringValue(payload, "policy") };
    recordOperationCall("policy.set", "PUT", "/api/v1/policy", body);
    return (await this.http.put("/api/v1/policy", body)).data;
  }
}
