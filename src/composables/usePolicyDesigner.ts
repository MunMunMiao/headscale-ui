import {
  type PolicyDesignerState,
  type PolicyGroup,
  type PolicyRule,
  type PolicyTagOwner,
  parsePolicy,
  serializePolicy,
} from "@/domain/policy-designer";
import type { ProductCopy } from "@/i18n/product-copy";
import { createStore } from "@/lib/store";
import { useSession, useStore } from "./session-context";

// Stored in policyError so every existing policyError write gate also covers Headscale file mode without a path.
export const POLICY_FILE_MODE_WITHOUT_PATH = "policy-file-mode-without-path";

export function policyBlockedMessage(
  copy: Pick<ProductCopy, "policyReadOnlyError" | "policyFileModeNoPath">,
  policyError: string | null,
) {
  return policyError === POLICY_FILE_MODE_WITHOUT_PATH
    ? copy.policyFileModeNoPath
    : copy.policyReadOnlyError;
}

export interface PolicySaveTicket {
  operationId: string;
  editRevision: number;
  submittedState: PolicyDesignerState;
  submittedText: string;
}

type PolicyRemovalTarget = {
  kind: "rule" | "group" | "tagOwner";
  id: string;
  label: string;
};
interface PolicyDesignerStoreState {
  editRevision: number;
  pendingPolicySave: PolicySaveTicket | null;
  policyDraft: string;
  policyError: string | null;
  policyRules: PolicyRule[];
  policyGroups: PolicyGroup[];
  policyTagOwners: PolicyTagOwner[];
  policyExtraSections: Record<string, unknown>;
  policyRemovalDialogOpen: boolean;
  pendingPolicyRemoval: PolicyRemovalTarget | null;
  // Resource-centric dialog state
  tagDetailOpen: boolean;
  tagDetailCurrent: string;
  teamDetailOpen: boolean;
  teamDetailCurrent: string;
  highRiskConfirmOpen: boolean;
  pendingHighRiskAction: (() => void) | null;
  editingIpRuleId: string | null;
  assignMembershipsOpen: boolean;
  assignTagOwnershipsOpen: boolean;
}

export function createPolicyDesignerStore() {
  const store = createStore<PolicyDesignerStoreState>({
    editRevision: 0,
    pendingPolicySave: null,
    policyDraft: "",
    policyError: null,
    policyRules: [],
    policyGroups: [],
    policyTagOwners: [],
    policyExtraSections: {},
    policyRemovalDialogOpen: false,
    pendingPolicyRemoval: null,
    tagDetailOpen: false,
    tagDetailCurrent: "",
    teamDetailOpen: false,
    teamDetailCurrent: "",
    highRiskConfirmOpen: false,
    pendingHighRiskAction: null,
    editingIpRuleId: null,
    assignMembershipsOpen: false,
    assignTagOwnershipsOpen: false,
  });
  let fileModeWithoutPath = false;
  const errorFor = (parseError?: string) =>
    fileModeWithoutPath ? POLICY_FILE_MODE_WITHOUT_PATH : (parseError ?? null);
  function designerState(): PolicyDesignerState {
    const state = store.getSnapshot();
    return {
      rules: state.policyRules,
      groups: state.policyGroups,
      tagOwners: state.policyTagOwners,
      extras: state.policyExtraSections,
      ...(state.policyError ? { error: state.policyError } : {}),
    };
  }
  function load(policyText: string) {
    closeAccessEditors();
    const state = parsePolicy(policyText);
    store.setState({
      editRevision: store.getSnapshot().editRevision + 1,
      pendingPolicySave: null,
      assignMembershipsOpen: false,
      assignTagOwnershipsOpen: false,
      policyRules: state.rules,
      policyGroups: state.groups,
      policyTagOwners: state.tagOwners,
      policyExtraSections: state.extras,
      policyDraft: policyText,
      policyError: errorFor(state.error),
    });
  }

  function closeAccessEditors() {
    store.setState({
      editingIpRuleId: null,
      tagDetailOpen: false,
      tagDetailCurrent: "",
      teamDetailOpen: false,
      teamDetailCurrent: "",
      policyRemovalDialogOpen: false,
      pendingPolicyRemoval: null,
      highRiskConfirmOpen: false,
      pendingHighRiskAction: null,
    });
  }

  function commitState(next: PolicyDesignerState) {
    if (store.getSnapshot().policyError) return;
    const current = designerState();
    let changed = true;
    try {
      changed = JSON.stringify(serializePolicy(current)) !== JSON.stringify(serializePolicy(next));
    } catch {
      changed =
        current.rules !== next.rules ||
        current.groups !== next.groups ||
        current.tagOwners !== next.tagOwners ||
        current.extras !== next.extras;
    }
    store.setState({
      editRevision: store.getSnapshot().editRevision + Number(changed),
      policyRules: next.rules,
      policyGroups: next.groups,
      policyTagOwners: next.tagOwners,
      policyExtraSections: next.extras,
      policyError: next.error ?? null,
    });
  }

  function beginSave(state: PolicyDesignerState): PolicySaveTicket | null {
    if (store.getSnapshot().pendingPolicySave || store.getSnapshot().policyError) return null;
    try {
      const ticket: PolicySaveTicket = {
        operationId: crypto.randomUUID(),
        editRevision: store.getSnapshot().editRevision,
        submittedState: structuredClone(state),
        submittedText: JSON.stringify(serializePolicy(state), null, 2),
      };
      store.setState({ pendingPolicySave: ticket });
      return ticket;
    } catch {
      return null;
    }
  }

  function acceptSavedPolicy(ticket: PolicySaveTicket, acceptedText: string) {
    const current = store.getSnapshot();
    if (current.pendingPolicySave?.operationId !== ticket.operationId)
      return { hasNewerEdits: true };
    const hasNewerEdits = current.editRevision !== ticket.editRevision;
    if (hasNewerEdits) {
      store.setState({ policyDraft: acceptedText });
      return { hasNewerEdits };
    }
    const accepted = parsePolicy(acceptedText);
    const next =
      !accepted.error &&
      JSON.stringify(serializePolicy(accepted)) ===
        JSON.stringify(serializePolicy(ticket.submittedState))
        ? ticket.submittedState
        : accepted;
    store.setState({
      policyDraft: acceptedText,
      policyRules: next.rules,
      policyGroups: next.groups,
      policyTagOwners: next.tagOwners,
      policyExtraSections: next.extras,
      policyError: errorFor(next.error),
    });
    return { hasNewerEdits };
  }

  function setFileModeWithoutPath(on: boolean) {
    if (on === fileModeWithoutPath) return;
    if (on) closeAccessEditors();
    fileModeWithoutPath = on;
    store.setState({
      policyError: errorFor(parsePolicy(store.getSnapshot().policyDraft).error),
    });
  }

  function finishSave(operationId: string) {
    if (store.getSnapshot().pendingPolicySave?.operationId === operationId)
      store.setState({ pendingPolicySave: null });
  }

  return {
    ...store,
    beginSave,
    acceptSavedPolicy,
    finishSave,
    get isPolicySaving() {
      return store.getSnapshot().pendingPolicySave !== null;
    },
    get policyDesignerState() {
      return designerState();
    },
    get policyPayload() {
      if (store.getSnapshot().policyError) return null;
      try {
        return serializePolicy(designerState());
      } catch {
        return null;
      }
    },
    get isPolicyDirty() {
      if (store.getSnapshot().policyError) return false;
      try {
        const baseline = JSON.stringify(
          serializePolicy(parsePolicy(store.getSnapshot().policyDraft)),
        );
        return baseline !== JSON.stringify(serializePolicy(designerState()));
      } catch {
        return true;
      }
    },
    get isPolicyEditing() {
      const state = store.getSnapshot();
      return (
        state.editingIpRuleId !== null ||
        state.assignMembershipsOpen ||
        state.assignTagOwnershipsOpen ||
        state.tagDetailOpen ||
        state.teamDetailOpen ||
        state.policyRemovalDialogOpen ||
        state.highRiskConfirmOpen
      );
    },
    load,
    closeAccessEditors,
    commitState,
    setFileModeWithoutPath,
  };
}

export function usePolicyDesigner() {
  return useStore(useSession().policy);
}
