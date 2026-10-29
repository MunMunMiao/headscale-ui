export function countPolicyWrites(logs: string): number {
  // Match complete nginx combined/main access records, not quoted requests in error context.
  return (
    logs.match(
      /^\S+ - \S+ \[[^\]\r\n]+\] "PUT \/api\/v1\/policy HTTP\/1\.[01]" \d{3} \d+ "[^"\r\n]*" "[^"\r\n]*"(?: "[^"\r\n]*")?\r?$/gm,
    ) ?? []
  ).length;
}
