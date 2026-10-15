import type { Infer } from "@defjs/core";
import { canonicalBaseUrl, connectionSettingsError } from "@/api/connection";
import { decryptProfileKey, encryptProfileKey, ProfileUnlockError } from "@/lib/api-key-crypto";
import type {
  ChangeProfilePasswordInput,
  MigrateProfileInput,
  ProfileList,
  ProfileWriteExpected,
  StoredProfileCommit,
  VaultVersion,
} from "@/lib/profile-storage";
import {
  changeProfilePassword,
  commitProfile,
  deleteStoredProfile,
  listProfileSummaries,
  migrateProfile,
  readProfileForOwner,
  updateProfileMetadata,
  VaultConflictError,
} from "@/lib/profile-storage";
import { assertResetExpected, clearAllSecureData } from "@/lib/secure-storage";
import { assertVaultVersion } from "@/lib/vault-state";
import { type AuthSession, type SessionExecutionContext, SessionFault } from "./auth-session";
import type { profileSaveInput } from "./protocol";
import type { PublicSessionSnapshot, SessionResult } from "./types";
import { ApiError } from "./types";

export type ProfileSaveInput = Infer<typeof profileSaveInput>;

export interface ProfileSaveOutcome {
  saved: true;
  commit: StoredProfileCommit;
  activation: SessionResult<PublicSessionSnapshot> | null;
}

export interface ProfileActionContext {
  ownerTabId: string;
  portId: string;
  requestId: string;
  signal: AbortSignal;
}

export interface ProfileResetOutcome {
  committed: true;
  version: VaultVersion;
  sessionMetadataCleared: false;
}

export interface ProfileActions {
  list(context: ProfileActionContext): Promise<SessionResult<ProfileList>>;
  save(
    input: ProfileSaveInput,
    context: ProfileActionContext,
  ): Promise<SessionResult<ProfileSaveOutcome>>;
  migrate(
    input: MigrateProfileInput,
    context: ProfileActionContext,
  ): Promise<SessionResult<StoredProfileCommit>>;
  changePassword(
    input: ChangeProfilePasswordInput,
    context: ProfileActionContext,
  ): Promise<SessionResult<StoredProfileCommit>>;
  delete(
    expected: ProfileWriteExpected,
    context: ProfileActionContext,
  ): Promise<SessionResult<{ version: VaultVersion }>>;
  reset(
    expected: VaultVersion | null,
    context: ProfileActionContext,
  ): Promise<SessionResult<ProfileResetOutcome>>;
}

export interface ProfileActionDependencies {
  workerId: string;
  auth: AuthSession;
  validate(context: SessionExecutionContext): Promise<void>;
  cancelPending(except: ProfileActionContext): Promise<void>;
  profilesCommitted(): void;
  resetCommitted(version: VaultVersion): void;
}

export function createProfileActions(deps: ProfileActionDependencies): ProfileActions {
  function failure(error: unknown, context: ProfileActionContext): SessionResult<never> {
    if (context.signal.aborted) return { ok: false, error: { kind: "cancelled" } };
    if (error instanceof SessionFault) return { ok: false, error: { kind: error.kind } };
    if (error instanceof VaultConflictError)
      return { ok: false, error: { kind: "storage-conflict" } };
    if (error instanceof ProfileUnlockError) return { ok: false, error: { kind: "unlock-failed" } };
    if (error instanceof ApiError)
      // ApiError carries a code exactly when its kind is "api".
      return error.code
        ? {
            ok: false,
            error: {
              kind: "api",
              code: error.code,
              message: error.message,
              status: error.status,
              data: error.data,
            },
          }
        : { ok: false, error: { kind: error.kind as Exclude<typeof error.kind, "api"> } };
    return { ok: false, error: { kind: "storage-failed" } };
  }
  async function attempt<T>(
    context: ProfileActionContext,
    run: () => Promise<T>,
  ): Promise<SessionResult<T>> {
    try {
      context.signal.throwIfAborted();
      return { ok: true, value: await run() };
    } catch (error) {
      return failure(error, context);
    }
  }
  const forOwner = (
    expected: ProfileWriteExpected,
    context: ProfileActionContext,
  ): ProfileWriteExpected => ({ ...expected, ownerTabId: context.ownerTabId });
  return {
    list: (context) => attempt(context, () => listProfileSummaries(context.ownerTabId)),
    save: (input, context) =>
      attempt(context, async () => {
        const expected = forOwner(input.expected, context);
        if (input.kind === "metadata") {
          const commit = await updateProfileMetadata(
            expected,
            { name: input.name, scope: input.scope },
            context.signal,
          );
          deps.auth.updateProfileName(commit.profile.id, commit.profile.name);
          deps.profilesCommitted();
          return { saved: true as const, commit, activation: null };
        }
        const baseUrl = canonicalBaseUrl(input.profile.baseUrl);
        const apiKey = input.apiKey.trim();
        if (
          !input.profile.id ||
          !input.password ||
          connectionSettingsError({ baseUrl: input.profile.baseUrl, apiKey }) ||
          (input.validation === "skip" && input.activate)
        )
          throw new SessionFault("invalid-request");
        const started = deps.auth.getSnapshot();
        const requireCurrent = () => {
          if (context.signal.aborted) throw new SessionFault("cancelled");
          const checked = deps.auth.check();
          if (!checked.ok) throw new SessionFault(checked.error.kind);
          const current = checked.value;
          if (
            input.expectedWorkerId !== deps.workerId ||
            input.expectedIdentity?.workerId !== current.identity?.workerId ||
            input.expectedIdentity?.sessionId !== current.identity?.sessionId ||
            (!input.expectedIdentity && current.revision !== started.revision)
          )
            throw new SessionFault("stale");
          if (current.pendingProfileId) throw new SessionFault("busy");
          return { baseUrl, apiKey };
        };
        requireCurrent();
        if (expected.profile) {
          const reference = expected.profile;
          if (reference.id !== input.profile.id) throw new VaultConflictError();
          const read = await readProfileForOwner(reference.id, context.ownerTabId).catch(
            async (error: unknown) => {
              // An unreadable row has no key or password left to prove: replacing it equals
              // deleting it and adding the server again. The commit re-checks this version.
              const listed = await listProfileSummaries(context.ownerTabId);
              const row = listed.profiles.find((item) => item.id === reference.id);
              if (row?.credentialKind !== "unreadable") throw error;
              if (row.credentialVersion !== reference.credentialVersion)
                throw new VaultConflictError();
              assertVaultVersion(listed.version, expected.version);
              return "unreadable" as const;
            },
          );
          if (read !== "unreadable") {
            if (
              !read?.profile.credentialVersion ||
              read.profile.credentialVersion !== reference.credentialVersion
            )
              throw new VaultConflictError();
            assertVaultVersion(read.version, expected.version);
            await decryptProfileKey({
              profileId: read.profile.id,
              canonicalBaseUrl: read.profile.baseUrl,
              credentialVersion: read.profile.credentialVersion,
              secret: read.profile.apiKey,
              password: input.password,
            });
          }
        } else {
          assertVaultVersion(
            (await listProfileSummaries(context.ownerTabId)).version,
            expected.version,
          );
        }
        requireCurrent();
        if (input.validation === "required")
          await deps.validate({ signal: context.signal, requireCurrent });
        requireCurrent();
        const credentialVersion = crypto.randomUUID();
        const apiKeySecret = await encryptProfileKey({
          profileId: input.profile.id,
          canonicalBaseUrl: baseUrl,
          credentialVersion,
          apiKey,
          password: input.password,
        });
        requireCurrent();
        const commit = await commitProfile(
          expected,
          {
            id: input.profile.id,
            name: input.profile.name.trim() || baseUrl,
            baseUrl,
            scope: input.profile.scope,
            ...(input.profile.scope === "session" ? { ownerTabId: context.ownerTabId } : {}),
            keyEpoch: expected.version.keyEpoch,
            credentialVersion,
            apiKey: apiKeySecret,
            updatedAt: new Date().toISOString(),
          },
          context.signal,
        );
        let activation: SessionResult<PublicSessionSnapshot> | null = null;
        if (input.activate) {
          try {
            requireCurrent();
          } catch (error) {
            activation = failure(error, context);
          }
        }
        deps.auth.invalidateProfile(commit.profile.id);
        deps.profilesCommitted();
        if (input.activate && !activation)
          activation = await deps.auth.unlock(
            {
              profileId: commit.profile.id,
              password: input.password,
              expectedWorkerId: deps.workerId,
              expectedIdentity: deps.auth.getSnapshot().identity,
              expectedCredentialVersion: credentialVersion,
              ownerTabId: context.ownerTabId,
              portId: context.portId,
              operationId: context.requestId,
            },
            { signal: context.signal },
          );
        return { saved: true as const, commit, activation };
      }),
    migrate: (input, context) =>
      attempt(context, async () => {
        const commit = await migrateProfile(
          { ...input, expected: forOwner(input.expected, context) },
          context.signal,
        );
        deps.auth.invalidateProfile(commit.profile.id);
        deps.profilesCommitted();
        return commit;
      }),
    changePassword: (input, context) =>
      attempt(context, async () => {
        const commit = await changeProfilePassword(
          { ...input, expected: forOwner(input.expected, context) },
          context.signal,
        );
        deps.auth.invalidateProfile(commit.profile.id);
        deps.profilesCommitted();
        return commit;
      }),
    delete: (expected, context) =>
      attempt(context, async () => {
        const { version, profileId } = await deleteStoredProfile(
          forOwner(expected, context),
          context.signal,
        );
        deps.auth.invalidateProfile(profileId);
        deps.profilesCommitted();
        return { version };
      }),
    reset: (expected, context) =>
      attempt(context, async () => {
        // A stale request must not lock every page before its transaction refuses it.
        await assertResetExpected(expected);
        deps.auth.lock(deps.auth.getSnapshot().identity);
        await deps.cancelPending(context);
        const result = await clearAllSecureData(expected, context.signal);
        deps.resetCommitted(result.version);
        return {
          committed: true as const,
          version: result.version,
          sessionMetadataCleared: false as const,
        };
      }),
  };
}
