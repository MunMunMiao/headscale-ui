import axios, { type AxiosError, type AxiosInstance } from "axios";

export interface ConnectionSettings {
  baseUrl: string;
  apiKey: string;
}

export function connectionSettingsError(settings: ConnectionSettings) {
  const baseUrl = settings.baseUrl.trim();
  if (!/^https?:\/\//i.test(baseUrl) || !URL.canParse(baseUrl)) {
    return "connectionInvalidUrl";
  }
  if (!settings.apiKey.trim()) return "connectionApiKeyRequired";
  return null;
}

export function createHeadscaleHttp(settings: ConnectionSettings): AxiosInstance {
  const error = connectionSettingsError(settings);
  if (error) {
    const message =
      error === "connectionInvalidUrl"
        ? "Enter an absolute HTTP(S) server URL."
        : "Enter an API key.";
    throw new Error(message);
  }
  const apiKey = settings.apiKey.trim();
  const client = axios.create({
    baseURL: settings.baseUrl.trim().replace(/\/$/, ""),
    timeout: 15_000,
  });

  client.interceptors.request.use((config) => {
    config.headers.Authorization = `Bearer ${apiKey}`;

    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    (error: AxiosError<{ message?: string }>) => {
      const message =
        error.response?.data?.message ??
        error.message ??
        "Headscale request failed. Check server URL and API key.";
      return Promise.reject(new Error(message));
    },
  );

  return client;
}
