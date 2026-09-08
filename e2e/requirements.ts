import type { OperationId } from "../src/domain/headscale-operations";
import type { Locale } from "../src/i18n/locales";

export type E2ERequirementKind = "control" | "rest" | "journey" | "recovery" | "locale";
export type E2EEnvironment = "browser-mock" | "docker-headscale";

type BaseRequirement = {
  id: string;
  kind: E2ERequirementKind;
  environment: E2EEnvironment;
  testTitle: string;
};

type RestRequirement = BaseRequirement & {
  kind: "rest";
  operationId: OperationId;
  driver: "ui" | "api-contract";
  evidence: string;
};

type LocaleRequirement = BaseRequirement & {
  kind: "locale";
  locale: Locale;
};

export type E2ERequirement =
  | RestRequirement
  | LocaleRequirement
  | (BaseRequirement & { kind: "control" | "journey" | "recovery" });

const realRestLifecycleTitle =
  "exercises every Headscale v0.28.0 REST operation with deterministic readback";
const localeLifecycleTitle =
  "defaults to English and switches through every supported BCP47 locale";

export const E2E_REQUIREMENTS = [
  {
    id: "control.actionable-controls",
    kind: "control",
    environment: "browser-mock",
    testTitle: "uses pointer cursors for buttons, links, menus and tabs",
  },

  ...(
    [
      ["health.check", "ui", 'expectUiOperationDelta("health.check"'],
      ["version.get", "ui", 'expectUiOperationDelta("version.get"'],
      ["user.list", "ui", 'expectUiOperationDelta("user.list"'],
      ["user.create", "ui", 'expectUiOperationDelta("user.create"'],
      ["user.rename", "ui", 'expectUiOperationDelta("user.rename"'],
      ["user.delete", "ui", 'expectUiOperationDelta("user.delete"'],
      ["preauthkey.list", "ui", 'expectUiOperationDelta("preauthkey.list"'],
      ["preauthkey.create", "ui", 'expectUiOperationDelta("preauthkey.create"'],
      ["preauthkey.expire", "ui", 'expectUiOperationDelta("preauthkey.expire"'],
      ["preauthkey.delete", "ui", 'expectUiOperationDelta("preauthkey.delete"'],
      ["node.list", "ui", 'expectUiOperationDelta("node.list"'],
      ["node.get", "api-contract", 'observeApiContract("node.get"'],
      ["node.register", "ui", 'expectUiOperationDelta("node.register"'],
      ["node.debugCreate", "api-contract", 'observeApiContract("node.debugCreate"'],
      ["node.rename", "ui", 'expectUiOperationDelta("node.rename"'],
      ["node.expire", "ui", 'expectUiOperationDelta("node.expire"'],
      ["node.delete", "ui", 'expectUiOperationDelta("node.delete"'],
      ["node.setTags", "ui", 'expectUiOperationDelta("node.setTags"'],
      ["node.setApprovedRoutes", "ui", 'expectUiOperationDelta("node.setApprovedRoutes"'],
      ["node.backfillIps", "ui", 'expectUiOperationDelta("node.backfillIps"'],
      ["apikey.list", "ui", 'expectUiOperationDelta("apikey.list"'],
      ["apikey.create", "ui", 'expectUiOperationDelta("apikey.create"'],
      ["apikey.expire", "ui", 'expectUiOperationDelta("apikey.expire"'],
      ["apikey.delete", "ui", 'expectUiOperationDelta("apikey.delete"'],
      ["policy.get", "ui", 'expectUiOperationDelta("policy.get"'],
      ["policy.set", "ui", 'expectUiOperationDelta("policy.set"'],
    ] as const
  ).map(([operationId, driver, evidence]) => ({
    id: `rest.${operationId}`,
    kind: "rest" as const,
    environment: "docker-headscale" as const,
    testTitle: realRestLifecycleTitle,
    operationId,
    driver,
    evidence,
  })),

  {
    id: "journey.profile-lifecycle",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "manages multiple saved connection profiles and supports logout",
  },
  {
    id: "journey.snapshot-refresh",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "refreshes data on every section change and repeated dialog open",
  },
  {
    id: "journey.tailnet-management",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "supports consumer-friendly tailnet management flows",
  },
  {
    id: "journey.device-lifecycle",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "covers dashboard refresh, machine filters, exports and machine lifecycle actions",
  },
  {
    id: "journey.user-lifecycle",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "covers user filters, user export and member deletion",
  },
  {
    id: "journey.auth-key-lifecycle",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "covers auth-key filters, expiration and deletion",
  },
  {
    id: "journey.policy-team",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "creates a team, adds a member, saves and reopens it",
  },
  {
    id: "journey.policy-label",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "creates a device label with an accessor + label manager and saves the rule",
  },
  {
    id: "journey.policy-cli-tag-owner",
    kind: "journey",
    environment: "docker-headscale",
    testTitle: "saves a live CLI user without email as a device-label manager against Headscale",
  },
  {
    id: "journey.policy-guard",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "unsaved-changes dialog covers cancel, discard and save-and-close paths",
  },
  {
    id: "journey.server-settings",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "covers server settings API keys and maintenance actions",
  },
  {
    id: "journey.registration",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "covers task navigation and the client-device setup branch",
  },
  {
    id: "journey.mobile",
    kind: "journey",
    environment: "browser-mock",
    testTitle: "keeps every core function usable on mobile",
  },

  {
    id: "recovery.bootstrap",
    kind: "recovery",
    environment: "browser-mock",
    testTitle: "renders bootstrap error recovery actions",
  },
  {
    id: "recovery.unlock",
    kind: "recovery",
    environment: "browser-mock",
    testTitle: "unlocks encrypted profiles and exposes forgotten-passphrase recovery",
  },
  {
    id: "recovery.credentials",
    kind: "recovery",
    environment: "browser-mock",
    testTitle: "asks before saving an unreachable profile and validates it before login",
  },
  {
    id: "recovery.snapshot-refresh",
    kind: "recovery",
    environment: "browser-mock",
    testTitle: "recovers a failed snapshot refresh without losing the current data",
  },
  {
    id: "recovery.mutation-retry",
    kind: "recovery",
    environment: "browser-mock",
    testTitle: "preserves a failed mutation and succeeds when retried",
  },

  ...(
    [
      "en-US",
      "zh-Hans",
      "zh-Hant-TW",
      "zh-Hant-HK",
      "ja-JP",
      "ko-KR",
      "fr-FR",
      "ru-RU",
      "es-ES",
      "it-IT",
      "ar",
    ] as const
  ).map((locale) => ({
    id: `locale.${locale}`,
    kind: "locale" as const,
    environment: "browser-mock" as const,
    testTitle: localeLifecycleTitle,
    locale,
  })),
] as const satisfies readonly E2ERequirement[];
