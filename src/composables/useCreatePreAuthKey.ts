import * as endpoints from "@/api/commands";
import type { AuthKeyDialogPayload } from "@/components/create-auth-key-dialog";
import { useDeviceSetup } from "./useDeviceSetup";
import { useMutation } from "./useMutation";

/** Creates an auth key; the one-time secret goes to the session store and is revealed once. */
export function useCreatePreAuthKey() {
  const { mutateWith } = useMutation();
  const { setState } = useDeviceSetup();
  return async (payload: AuthKeyDialogPayload) => {
    setState({ lastCreatedInvite: "" });
    const created = await mutateWith("create-invite", endpoints.createPreAuthKey(payload));
    if (!created.ok) return false;
    setState({ lastCreatedInvite: created.result.preAuthKey.key, revealCreatedInvite: true });
    return true;
  };
}
