import { type RefObject, useEffect } from "react";
import type { HeadscaleNode } from "@/api/contracts";
import { createStore } from "@/lib/store";
import { useSession, useStore } from "./session-context";

export type AddDeviceTask = "server" | "client" | "pending";
type AddDeviceStep =
  "type" | "preferences" | "authKey" | "generate" | "pending" | "result";

interface DeviceSetupState {
  open: boolean;
  task: AddDeviceTask | null;
  step: AddDeviceStep;
  authKeyExpiryDays: number;
  /** The `--login-server` the admin typed for this session; null uses the profile's address. */
  loginServer: string | null;
  lastCreatedInvite: string;
  /** One-shot: focus the created key once; the key itself persists in the session store. */
  revealCreatedInvite: boolean;
  lastRegisteredNode: HeadscaleNode | null;
  pendingRegistrationForm: {
    user: string;
    key: string;
    kind: "device" | "ssh";
  };
  lastAuthDecision: "approved" | "rejected" | null;
}

export function createDeviceSetupStore() {
  return createStore<DeviceSetupState>({
    open: false,
    task: null,
    step: "type",
    authKeyExpiryDays: 7,
    loginServer: null,
    lastCreatedInvite: "",
    revealCreatedInvite: false,
    lastRegisteredNode: null,
    pendingRegistrationForm: { user: "", key: "", kind: "device" },
    lastAuthDecision: null,
  });
}

export function useDeviceSetup() {
  return useStore(useSession().deviceSetup);
}

export function useRevealCreatedInvite(
  ref: RefObject<HTMLElement | null>,
  ready = true,
) {
  const { revealCreatedInvite, lastCreatedInvite, setState } = useDeviceSetup();
  useEffect(() => {
    if (!revealCreatedInvite || !lastCreatedInvite || !ready || !ref.current)
      return;
    ref.current.scrollIntoView({ block: "nearest" });
    ref.current.focus();
    setState({ revealCreatedInvite: false });
  }, [revealCreatedInvite, lastCreatedInvite, ready, ref, setState]);
}
