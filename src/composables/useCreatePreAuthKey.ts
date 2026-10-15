import type { AuthKeyDialogPayload } from "@/components/create-auth-key-dialog";
import { useDeviceSetup } from "./useDeviceSetup";
import { useMutation } from "./useMutation";

/**
 * Creates an auth key; the one-time secret goes to the session store and is revealed once. The
 * previous secret is only replaced on success: a failed attempt must not lose the only copy of it.
 */
export function useCreatePreAuthKey() {
  const { mutateWith } = useMutation();
  const { setState } = useDeviceSetup();
  return async (payload: AuthKeyDialogPayload) => {
    const created = await mutateWith("create-invite", {
      endpoint: "createPreAuthKey",
      input: payload,
    });
    if (!created.ok) return false;
    setState({ lastCreatedInvite: created.result.preAuthKey.key, revealCreatedInvite: true });
    return true;
  };
}
