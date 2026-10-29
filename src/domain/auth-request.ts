// Headscale validates only the prefix and the total length (38) of an auth id.
const ID = /^hskey-authreq-[\x21-\x7e]{24}$/;

export type AuthRequestSource = "bare" | "register-link" | "auth-link";

export interface AuthRequest {
  id: string;
  source: AuthRequestSource;
  /** Public login-server, including any base path; not necessarily the API proxy address. */
  loginServer?: string;
}

/** A public server address, never a credential or a one-time request URL. */
export function normalizePublicLoginServer(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /(?:^|\/)hskey-(?:authreq|auth|api)-[^/]+/i.test(
        decodeURIComponent(url.pathname),
      )
    )
      return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Preserves the link's server. A matching server is not proof of the requesting device. */
export function parseAuthRequest(input: string): AuthRequest | null {
  const text = input.trim();
  if (ID.test(text)) return { id: text, source: "bare" };
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const [kind, id] = parts.slice(-2);
  if (!id || !ID.test(id) || (kind !== "register" && kind !== "auth"))
    return null;
  const basePath = parts.slice(0, -2).join("/");
  return {
    id,
    source: kind === "register" ? "register-link" : "auth-link",
    loginServer: `${url.origin}${basePath ? `/${basePath}` : ""}`,
  };
}

// A protocol token, not a translated message.
export const AUTH_ID_PLACEHOLDER = "hskey-authreq-…";
