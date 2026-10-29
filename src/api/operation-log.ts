const privateField =
  /^(?:authorization|headers|request|response|cause|stack|apiKey|authId|password|key|secret|token)$/i;

export function redactDiagnosticData<T>(value: T, secret: string): T {
  if (typeof value === "string")
    return (secret ? value.replaceAll(secret, "[redacted]") : value) as T;
  if (Array.isArray(value))
    return value.map((entry) => redactDiagnosticData(entry, secret)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        privateField.test(key)
          ? "[redacted]"
          : redactDiagnosticData(entry, secret),
      ]),
    ) as T;
  return value;
}
