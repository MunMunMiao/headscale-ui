import type { FaultCode } from "@defjs/core";
import { isolateVersion, UnsupportedServerVersionError } from "@/domain/server-version";
import { i18n, t } from "@/i18n";
import { type MessageKey, productDescriptors } from "@/i18n/descriptors";
import type { SessionFailureKind } from "@/session/types";
import { ApiError } from "@/session/types";

const sessionErrorKeys = {
  locked: "sessionLocked",
  expired: "sessionExpired",
  stale: "sessionChanged",
  busy: "sessionBusy",
  "unlock-failed": "encryptionUnlockFailed",
  "storage-conflict": "vaultConflict",
  "storage-failed": "storageWrite",
  unavailable: "sessionUnavailable",
  cancelled: "sessionCancelled",
  "invalid-request": "sessionInvalidRequest",
  "reload-required": "sessionReloadRequired",
} satisfies Record<SessionFailureKind, MessageKey>;

// null = internal fault, never user-reachable: keep the defjs diagnostic message.
const faultKeys = {
  NET_ABORTED: "sessionCancelled",
  NET_TIMEOUT: "requestUnreachable",
  NET_UNREACHABLE: "requestUnreachable",
  NET_BODY_INCOMPLETE: "requestUnreachable",
  HTTP_STATUS: "requestUnexpectedResponse",
  RES_DECODE_FAILED: "requestUnexpectedResponse",
  RES_MEDIA_TYPE_INVALID: "requestUnexpectedResponse",
  RES_STRUCT_MISMATCH: "requestUnexpectedResponse",
  REQ_BUILD_FAILED: null,
  REQ_INPUT_INVALID: null,
  REQ_OPTIONS_INVALID: null,
  CAP_BUFFER_EXCEEDED: null,
  CAP_QUEUE_OVERFLOW: null,
  ENV_UNSUPPORTED: null,
  EXT_HOOK_FAILED: null,
  EXT_INTERCEPTOR_FAILED: null,
  EXT_OBSERVER_FAILED: null,
} satisfies Record<FaultCode, MessageKey | null>;

type ProductKey =
  | "errorRequestFailed"
  | "errorUserStillOwns"
  | "errorUserNotFound"
  | "errorNodeNotFound"
  | "errorInvalidDnsLabel"
  | "errorNodeNameTaken"
  | "errorTagsNotPermitted"
  | "errorCannotRemoveAllTags"
  | "errorUserNameTaken"
  | "policyUpdateDisabled";

// Headscale v0.29.4 strings (db/users.go, grpcv1.go, state/state.go, types/node.go), matched
// case-insensitively.
const headscalePhrases: readonly (readonly [RegExp, ProductKey])[] = [
  [/user not empty/i, "errorUserStillOwns"],
  [/user not found/i, "errorUserNotFound"],
  [/node not found/i, "errorNodeNotFound"],
  [/is not a valid DNS label/i, "errorInvalidDnsLabel"],
  [/node name is not unique/i, "errorNodeNameTaken"],
  [/requested tags .* are invalid or not permitted/i, "errorTagsNotPermitted"],
  [/cannot remove all tags from (a )?node/i, "errorCannotRemoveAllTags"],
  [/UNIQUE constraint failed: users\.name/i, "errorUserNameTaken"],
  [/update is disabled for modes other than 'database'/i, "policyUpdateDisabled"],
];

const product = (key: ProductKey) => i18n._(productDescriptors[key].id);

function isFaultCode(code: unknown): code is FaultCode {
  return typeof code === "string" && Object.hasOwn(faultKeys, code);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof UnsupportedServerVersionError)
    return t("serverVersionUnreadable", { version: isolateVersion(error.serverVersion) });
  if (error instanceof ApiError && error.outcome === "unknown") return t("sessionOutcomeUnknown");
  if (error instanceof ApiError && error.kind !== "api") return t(sessionErrorKeys[error.kind]);
  if (error instanceof Error && "code" in error && isFaultCode(error.code)) {
    const code = error.code;
    const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
    const serverText =
      code === "HTTP_STATUS" &&
      "data" in error &&
      typeof error.data === "object" &&
      error.data !== null &&
      "message" in error.data &&
      typeof error.data.message === "string"
        ? error.data.message.trim()
        : "";
    // Headscale answers every bad, expired or missing bearer with a plain-text 401.
    if (status === 401) return product("errorRequestFailed");
    if (serverText) {
      const phrase = headscalePhrases.find(([pattern]) => pattern.test(serverText));
      return phrase ? product(phrase[1]) : serverText;
    }
    if (status === 403) return product("errorRequestFailed");
    const key = faultKeys[code];
    if (key) return t(key, { status: status ?? "?" });
  }
  return error instanceof Error ? error.message : String(error);
}
