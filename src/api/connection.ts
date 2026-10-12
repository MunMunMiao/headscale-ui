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
