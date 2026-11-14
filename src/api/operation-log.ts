import { struct } from "@defjs/core";
import { RpcStatus } from "./contracts";

const privateField =
  /^(?:authorization|headers|request|response|cause|stack|apiKey|authId|password|key|secret|token)$/i;

export function redactDiagnosticData(value: string, secret: string): string;
export function redactDiagnosticData(value: unknown, secret: string): unknown;
export function redactDiagnosticData(value: unknown, secret: string): unknown {
  if (typeof value === "string")
    return secret ? value.replaceAll(secret, "[redacted]") : value;
  if (Array.isArray(value))
    return value.map((entry) => redactDiagnosticData(entry, secret));
  if (value !== null && typeof value === "object") {
    const entries: [string, unknown][] = Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, entry]): [string, unknown] => [
        key,
        privateField.test(key)
          ? "[redacted]"
          : redactDiagnosticData(entry, secret),
      ]),
    );
  }
  return value;
}

/** Redacts an error body and revalidates it against the same response contract. */
export function redactStatusData(
  value: RpcStatus | undefined,
  secret: string,
): RpcStatus | undefined {
  if (value === undefined) return undefined;
  const [err, data] = struct.parse(
    RpcStatus,
    redactDiagnosticData(value, secret),
  );
  if (err) return undefined;
  return data;
}
