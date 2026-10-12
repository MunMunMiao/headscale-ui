// Headscale validates only the prefix and the total length (38) of an auth id.
const ID = /^hskey-authreq-[\x21-\x7e]{24}$/;

export type AuthRequestSource = "bare" | "register-link" | "auth-link";

/** Extracts a pending auth id from a bare id or from a registration / SSH check link. */
export function parseAuthRequest(input: string): { id: string; source: AuthRequestSource } | null {
  const text = input.trim();
  if (ID.test(text)) return { id: text, source: "bare" };
  if (!URL.canParse(text)) return null;
  const [kind, id] = new URL(text).pathname.split("/").filter(Boolean).slice(-2);
  if (!id || !ID.test(id)) return null;
  return kind === "register"
    ? { id, source: "register-link" }
    : kind === "auth"
      ? { id, source: "auth-link" }
      : null;
}

// A protocol token, not a translated message.
export const AUTH_ID_PLACEHOLDER = "hskey-authreq-…";
