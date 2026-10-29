import type { PolicyDesignerState, PolicyRule } from "@/domain/policy-designer";

export function addRule(
  state: PolicyDesignerState,
  rule: PolicyRule,
): PolicyDesignerState {
  return { ...state, rules: [...state.rules, rule] };
}
