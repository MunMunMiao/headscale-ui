export type ServerVersionSupport = "supported" | "unsupported" | "unknown";

const SUPPORTED_SERIES = "0.29";

/** The `major.minor` series decides support; unparseable strings such as `dev` stay unknown. */
export function serverVersionSupport(version: string): ServerVersionSupport {
  const match = /^v?(\d+)\.(\d+)(?=[.\-+]|$)/.exec(version.trim());
  if (!match) return "unknown";
  return `${match[1]}.${match[2]}` === SUPPORTED_SERIES
    ? "supported"
    : "unsupported";
}

/** Thrown when the device list cannot be read and the server reports an unsupported series. */
export class UnsupportedServerVersionError extends Error {
  constructor(
    readonly serverVersion: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Unsupported Headscale version: ${isolateVersion(serverVersion)}`,
      options,
    );
    this.name = "UnsupportedServerVersionError";
  }
}

/** Server-supplied text goes into translated sentences: bound it and isolate its bidi direction. */
export function isolateVersion(version: string): string {
  return `\u2068${version.trim().slice(0, 40)}\u2069`;
}
