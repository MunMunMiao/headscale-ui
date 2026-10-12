import {
  createGroup,
  createRule,
  createTagOwner,
  type PolicyDesignerState,
  toMemberRef,
} from "./policy-designer";
import { hasOnlyDefaultAccess } from "./policy-views";

export type PolicyTemplateId = "self-only" | "small-team" | "split-env";

export interface PolicyTemplate {
  id: PolicyTemplateId;
  /** i18n key for the human-friendly title shown on the template card. */
  titleKey: string;
  /** i18n key for the one-line description shown under the title. */
  descriptionKey: string;
  build(): Partial<PolicyDesignerState>;
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "self-only",
    titleKey: "templateSelfOnlyTitle",
    descriptionKey: "templateSelfOnlyDescription",
    build() {
      const personal = createTagOwner("tag:personal", []);
      const rule = createRule("*", "tag:personal", "*");
      return {
        rules: [rule],
        groups: [],
        tagOwners: [personal],
      };
    },
  },
  {
    id: "small-team",
    titleKey: "templateSmallTeamTitle",
    descriptionKey: "templateSmallTeamDescription",
    build() {
      const team = createGroup("group:team", []);
      const shared = createTagOwner("tag:shared", [toMemberRef("group:team")]);
      const rule = createRule("group:team", "tag:shared", "22,80,443");
      return {
        rules: [rule],
        groups: [team],
        tagOwners: [shared],
      };
    },
  },
  {
    id: "split-env",
    titleKey: "templateSplitEnvTitle",
    descriptionKey: "templateSplitEnvDescription",
    build() {
      const dev = createGroup("group:dev", []);
      const ops = createGroup("group:ops", []);
      const devServer = createTagOwner("tag:dev-server", [toMemberRef("group:ops")]);
      const prodServer = createTagOwner("tag:prod-server", [toMemberRef("group:ops")]);
      const rules = [
        createRule("group:dev", "tag:dev-server", "22,80,443"),
        createRule("group:ops", "tag:dev-server,tag:prod-server", "*"),
      ];
      return {
        rules,
        groups: [dev, ops],
        tagOwners: [devServer, prodServer],
      };
    },
  },
];

export function applyTemplate(
  state: PolicyDesignerState,
  template: PolicyTemplate,
): PolicyDesignerState {
  const built = template.build();
  const added = built.rules ?? [];
  // Headscale ACLs are an allow-list: scoped rules after the open default would enforce nothing.
  const rules =
    added.length > 0 && hasOnlyDefaultAccess(state) ? added : [...state.rules, ...added];
  return {
    ...state,
    rules,
    groups: [...state.groups, ...(built.groups ?? [])],
    tagOwners: [...state.tagOwners, ...(built.tagOwners ?? [])],
  };
}
