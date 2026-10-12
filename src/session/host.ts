import { createHeadscaleGateway } from "@/api/gateway";
import { fetchSnapshot } from "@/api/snapshot";
import { decryptProfileKey } from "@/lib/api-key-crypto";
import { DB_VERSION, openHeadscaleDb } from "@/lib/idb";
import { readProfileForOwner } from "@/lib/profile-storage";
import {
  type CandidateCredential,
  type SessionExecutionContext,
  SessionFault,
} from "./auth-session";
import { executeOperation } from "./operation-dispatch";
import { createProfileActions } from "./profile-actions";
import { createSessionProtocol } from "./protocol";
import { createSessionRuntime } from "./runtime";

export async function createSessionHost(buildId: string) {
  await openHeadscaleDb();
  const workerId = crypto.randomUUID();
  async function validate(context: SessionExecutionContext) {
    await fetchSnapshot(
      createHeadscaleGateway((command) => executeOperation(command, context)),
      {
        signal: context.signal,
      },
    );
  }
  const runtime = createSessionRuntime({
    auth: {
      workerId,
      now: Date.now,
      newSessionId: () => crypto.randomUUID(),
      async openCredential(input, signal) {
        signal.throwIfAborted();
        const read = await readProfileForOwner(input.profileId, input.ownerTabId);
        if (!read?.profile.credentialVersion) throw new SessionFault("unlock-failed");
        const profile = read.profile;
        const credentialVersion = read.profile.credentialVersion;
        const apiKey = await decryptProfileKey({
          profileId: profile.id,
          canonicalBaseUrl: profile.baseUrl,
          credentialVersion,
          secret: profile.apiKey,
          password: input.password,
        });
        signal.throwIfAborted();
        const candidate: CandidateCredential = {
          profile: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl },
          apiKey,
          keyEpoch: profile.keyEpoch,
          credentialVersion,
        };
        return candidate;
      },
      async readCurrentProfile(candidate, ownerTabId) {
        const read = await readProfileForOwner(candidate.profile.id, ownerTabId);
        return read &&
          read.version.keyEpoch === candidate.keyEpoch &&
          read.profile.credentialVersion === candidate.credentialVersion
          ? { id: read.profile.id, name: read.profile.name, baseUrl: read.profile.baseUrl }
          : null;
      },
      validateCredential: (candidate, signal, requireCandidate) =>
        validate({
          signal,
          requireCurrent() {
            requireCandidate();
            return { baseUrl: candidate.profile.baseUrl, apiKey: candidate.apiKey };
          },
        }),
      execute: executeOperation,
    },
  });
  const profiles = createProfileActions({
    workerId,
    auth: runtime.auth,
    validate,
    cancelPending: runtime.cancelPending,
    profilesCommitted: () => protocol.notifyProfiles(),
    resetCommitted: (version) => protocol.notifyReset(version),
  });
  const protocol = createSessionProtocol({
    runtime,
    profiles,
    workerId,
    buildId,
    storageVersion: DB_VERSION,
  });
  return {
    connect: protocol.connect,
    async dispose() {
      await protocol.dispose();
      await runtime.dispose();
    },
  };
}
