import {
  canaryKeyParameters,
  decryptApiKey,
  deriveKeyFromPassword,
  isEncryptedApiKey,
  ProfileUnlockError,
  parseCanaryRecord,
  verifyCanaryRecord,
} from "./api-key-crypto";
import { VaultDataError } from "./vault-state";

export interface ReadLegacyProfileKeyInput {
  secret: unknown;
  deviceKey?: CryptoKey | null;
  canary?: unknown;
  password?: string;
}

function validateCiphertext(secret: { iv: string; ct: string }): void {
  try {
    if (atob(secret.iv).length !== 12 || atob(secret.ct).length < 16) throw new VaultDataError();
  } catch {
    throw new VaultDataError();
  }
}

export async function readLegacyProfileKey(input: ReadLegacyProfileKeyInput): Promise<string> {
  if (typeof input.secret === "string") return input.secret;
  if (!isEncryptedApiKey(input.secret)) throw new VaultDataError();
  validateCiphertext(input.secret);
  let key: CryptoKey;
  if (input.secret.scheme === "device") {
    if (!input.deviceKey) throw new VaultDataError();
    key = input.deviceKey;
  } else {
    const canary = parseCanaryRecord(input.canary);
    if (!canary) throw new VaultDataError();
    validateCiphertext(canary);
    if (!input.password) throw new ProfileUnlockError();
    let parameters: ReturnType<typeof canaryKeyParameters>;
    try {
      parameters = canaryKeyParameters(canary);
      if (!parameters.salt.length) throw new VaultDataError();
    } catch {
      throw new VaultDataError();
    }
    key = await deriveKeyFromPassword(input.password, parameters.salt, parameters.iterations);
    if (!(await verifyCanaryRecord(canary, key))) throw new ProfileUnlockError();
  }
  try {
    return await decryptApiKey(input.secret, key);
  } catch {
    throw new ProfileUnlockError();
  }
}
