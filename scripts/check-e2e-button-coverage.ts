import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ElementNode, RootNode, TemplateChildNode } from "@vue/compiler-dom";
import { baseParse, ElementTypes, NodeTypes } from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { E2E_REQUIREMENTS, type E2ERequirementKind } from "../e2e/requirements";
import { OPERATION_IDS } from "../src/domain/headscale-operations";
import { SUPPORTED_LOCALES } from "../src/i18n/locales";

type SourceTarget = {
  file: string;
  line: number;
  tag: string;
  testIdPattern: string;
};

function collectVueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectVueFiles(full));
    } else if (entry.endsWith(".vue") && !entry.endsWith(".test.vue")) {
      out.push(full);
    }
  }
  return out;
}

const COMPONENT_FILES = collectVueFiles("src/components").filter(
  (file) => !file.startsWith("src/components/ui/"),
);
const SOURCE_FILES = [...collectVueFiles("src/pages"), ...COMPONENT_FILES];
const E2E_FILE = "e2e/headscale-ui.browser.test.ts";
const REQUIREMENT_KINDS: readonly E2ERequirementKind[] = [
  "control",
  "rest",
  "journey",
  "recovery",
  "locale",
];
const FLOW_TAGS = new Set([
  "AlertDialogCancel",
  "Button",
  "Checkbox",
  "DateTimePicker",
  "DropdownMenuItem",
  "DropdownMenuSubTrigger",
  "Input",
  "NativeSelect",
  "Switch",
  "TabsTrigger",
  "button",
]);

function normalizeTestId(value: string) {
  return value
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\$\{[^}]+}/g, "*")
    .replace(/\s+/g, " ");
}

function patternToRegExp(pattern: string) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${escaped}$`);
}

function patternMatches(pattern: string, value: string) {
  return pattern.includes("*") ? patternToRegExp(pattern).test(value) : pattern === value;
}

function patternsOverlap(sourcePattern: string, interactionPattern: string) {
  if (!sourcePattern.includes("*")) {
    return patternMatches(interactionPattern, sourcePattern);
  }
  if (!interactionPattern.includes("*")) {
    return patternMatches(sourcePattern, interactionPattern);
  }

  const sourcePrefix = sourcePattern.split("*")[0] ?? "";
  const interactionPrefix = interactionPattern.split("*")[0] ?? "";
  return sourcePrefix.startsWith(interactionPrefix) || interactionPrefix.startsWith(sourcePrefix);
}

type TemplateNode = RootNode | TemplateChildNode;

function readTestIdAttribute(prop: ElementNode["props"][number]) {
  if (prop.type === NodeTypes.ATTRIBUTE && prop.name === "data-testid") {
    return prop.value?.content;
  }

  if (
    prop.type === NodeTypes.DIRECTIVE &&
    prop.name === "bind" &&
    prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
    prop.arg.content === "data-testid"
  ) {
    return prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp.content : undefined;
  }

  return undefined;
}

function hasStaticAttribute(node: ElementNode, name: string, value?: string) {
  return node.props.some((prop) => {
    if (prop.type !== NodeTypes.ATTRIBUTE || prop.name !== name) return false;
    return value === undefined || prop.value?.content === value;
  });
}

function isDecorativeFlowControl(node: ElementNode) {
  return node.tag === "Checkbox" && hasStaticAttribute(node, "tabindex", "-1");
}

async function collectSourceTargets() {
  const targets: SourceTarget[] = [];
  const missingTestIds: SourceTarget[] = [];

  for (const file of SOURCE_FILES) {
    const source = await Bun.file(file).text();
    const parsed = parseSfc(source, { filename: file });
    const template = parsed.descriptor.template?.content;
    if (!template) {
      continue;
    }

    const ast = baseParse(template);
    const visit = (node: TemplateNode) => {
      if (node.type === NodeTypes.ELEMENT) {
        const tag = node.tag;
        if (
          FLOW_TAGS.has(tag) &&
          (node.tagType === ElementTypes.ELEMENT || node.tagType === ElementTypes.COMPONENT) &&
          !isDecorativeFlowControl(node)
        ) {
          const testId = node.props
            .map(readTestIdAttribute)
            .find((value): value is string => Boolean(value));
          if (testId) {
            targets.push({
              file,
              line: node.loc.start.line,
              tag,
              testIdPattern: normalizeTestId(testId),
            });
          } else {
            missingTestIds.push({
              file,
              line: node.loc.start.line,
              tag,
              testIdPattern: "<missing>",
            });
          }
        }
      }

      const children = "children" in node ? node.children : [];
      for (const child of children) {
        visit(child);
      }
    };

    visit(ast);
  }

  return { targets, missingTestIds };
}

function collectInteractions(source: string) {
  const interactions = new Set<string>();
  const add = (value: string) => interactions.add(normalizeTestId(value));

  const directInteraction =
    /getByTestId\(\s*("[^"]+"|`[^`]+`)\s*\)\s*\.(?:click|fill|selectOptions|hover)/g;
  for (const match of source.matchAll(directInteraction)) {
    add(match[1] ?? "");
  }

  const helperInteraction =
    /(?:clickDomTestId|clickVisibleDomTestId|clickLastByTestIdPrefix|inputDomTestId|inputLastByTestIdPrefix|selectDomTestId|selectDomTab|chooseProfileMenuOption)\(\s*("[^"]+"|`[^`]+`)/g;
  for (const match of source.matchAll(helperInteraction)) {
    add(match[1] ?? "");
  }

  const sectionTab = /selectSectionTab\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(sectionTab)) {
    add(`section-${match[1] ?? ""}`);
  }

  const prefixClick = /(?:clickLastByTestIdPrefix|inputLastByTestIdPrefix)\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(prefixClick)) {
    add(`${match[1] ?? ""}*`);
  }

  return interactions;
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues].sort();
}

function collectTestTitles(source: string) {
  const runnableMatches = [...source.matchAll(/\btest\(\s*"([^"]+)"/g)];
  const runnableTitles = runnableMatches.map((match) => match[1] ?? "");
  const runnable = new Set(runnableTitles);
  const bodies = new Map<string, string>();
  for (const [index, match] of runnableMatches.entries()) {
    const start = match.index ?? 0;
    const end = runnableMatches[index + 1]?.index ?? source.length;
    bodies.set(match[1] ?? "", source.slice(start, end));
  }
  const blocked = new Set(
    [...source.matchAll(/\btest\.(?:skip|todo|skipIf|runIf)\b[\s\S]{0,200}?"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  return { runnable, runnableTitles, bodies, blocked };
}

function compareRequiredValues(
  label: string,
  expected: readonly string[],
  actual: readonly string[],
) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return [
    ...expected
      .filter((value) => !actualSet.has(value))
      .map((value) => `Missing ${label}: ${value}`),
    ...actual
      .filter((value) => !expectedSet.has(value))
      .map((value) => `Unknown ${label}: ${value}`),
    ...duplicates(actual).map((value) => `Duplicate ${label}: ${value}`),
  ];
}

const e2eSource = await Bun.file(E2E_FILE).text();
const { targets, missingTestIds } = await collectSourceTargets();
const interactions = collectInteractions(e2eSource);
const missingCoverage = targets.filter(
  (target) =>
    !Array.from(interactions).some((interaction) =>
      patternsOverlap(target.testIdPattern, interaction),
    ),
);
const {
  runnable: runnableTitles,
  runnableTitles: allRunnableTitles,
  bodies: runnableBodies,
  blocked: blockedTitles,
} = collectTestTitles(e2eSource);
const mappedTitles = [...new Set(E2E_REQUIREMENTS.map((requirement) => requirement.testTitle))];
const expectedRestEvidence = (operationId: string, driver: "ui" | "api-contract") =>
  driver === "ui"
    ? `expectUiOperationDelta("${operationId}"`
    : `observeApiContract("${operationId}"`;
const includesIgnoringWhitespace = (source: string | undefined, value: string) =>
  source?.replace(/\s+/g, "").includes(value.replace(/\s+/g, "")) ?? false;
const requirementErrors = [
  ...duplicates(allRunnableTitles).map((title) => `Duplicate runnable test title: ${title}`),
  ...duplicates(E2E_REQUIREMENTS.map((requirement) => requirement.id)).map(
    (id) => `Duplicate requirement id: ${id}`,
  ),
  ...E2E_REQUIREMENTS.filter((requirement) => !runnableTitles.has(requirement.testTitle)).map(
    (requirement) => `Missing runnable test for ${requirement.id}: ${requirement.testTitle}`,
  ),
  ...E2E_REQUIREMENTS.filter((requirement) => blockedTitles.has(requirement.testTitle)).map(
    (requirement) =>
      `Required test is skipped/todo for ${requirement.id}: ${requirement.testTitle}`,
  ),
  ...mappedTitles
    .filter((title) => {
      const body = runnableBodies.get(title);
      return body !== undefined && !/\bexpect(?:\.|\()/.test(body);
    })
    .map((title) => `Required test has no runtime assertion: ${title}`),
  ...E2E_REQUIREMENTS.filter(
    (requirement) =>
      requirement.kind === "rest" &&
      !includesIgnoringWhitespace(runnableBodies.get(requirement.testTitle), requirement.evidence),
  ).map(
    (requirement) =>
      `Missing REST execution evidence for ${requirement.operationId}: ${requirement.evidence}`,
  ),
  ...E2E_REQUIREMENTS.filter(
    (requirement) =>
      requirement.kind === "rest" &&
      requirement.evidence !== expectedRestEvidence(requirement.operationId, requirement.driver),
  ).map(
    (requirement) =>
      `Invalid ${requirement.driver} evidence for ${requirement.operationId}: expected ${expectedRestEvidence(requirement.operationId, requirement.driver)}`,
  ),
  ...E2E_REQUIREMENTS.filter((requirement) => {
    if (requirement.kind !== "rest") return false;
    const body = runnableBodies.get(requirement.testTitle);
    return (
      !body?.includes("requiredUiOperationIds") ||
      !body.includes("observedUiOperationIds") ||
      !body.includes("requiredApiContractOperationIds") ||
      !body.includes("observedApiContractOperationIds")
    );
  }).map(
    (requirement) =>
      `Missing driver-separated runtime reconciliation for ${requirement.operationId}: ${requirement.testTitle}`,
  ),
  ...E2E_REQUIREMENTS.filter(
    (requirement) =>
      requirement.kind === "rest" &&
      requirement.driver === "ui" &&
      requirement.evidence.includes("client."),
  ).map(
    (requirement) =>
      `UI requirement cannot use direct client evidence for ${requirement.operationId}`,
  ),
  ...E2E_REQUIREMENTS.filter(
    (requirement) =>
      requirement.kind === "locale" &&
      (!runnableBodies.get(requirement.testTitle)?.includes("loginLocales.add(code)") ||
        !runnableBodies.get(requirement.testTitle)?.includes("appLocales.add(code)")),
  ).map(
    (requirement) =>
      `Missing login/app locale runtime evidence for ${requirement.locale}: ${requirement.testTitle}`,
  ),
  ...compareRequiredValues(
    "REST operation requirement",
    OPERATION_IDS,
    E2E_REQUIREMENTS.filter((requirement) => requirement.kind === "rest").map(
      (requirement) => requirement.operationId,
    ),
  ),
  ...compareRequiredValues(
    "locale requirement",
    SUPPORTED_LOCALES,
    E2E_REQUIREMENTS.filter((requirement) => requirement.kind === "locale").map(
      (requirement) => requirement.locale,
    ),
  ),
];

if (missingTestIds.length > 0 || missingCoverage.length > 0 || requirementErrors.length > 0) {
  const lines = [
    "E2E button/flow coverage check failed.",
    "",
    ...missingTestIds.map(
      (target) => `Missing data-testid: ${target.file}:${target.line} <${target.tag}>`,
    ),
    ...missingCoverage.map(
      (target) =>
        `Missing interaction: ${target.file}:${target.line} <${target.tag}> ${target.testIdPattern}`,
    ),
    ...requirementErrors,
  ].filter(Boolean);

  console.error(lines.join("\n"));
  process.exit(1);
}

console.log(
  `E2E control coverage: ${targets.length}/${targets.length} controls mapped by ${interactions.size} interactions.`,
);
for (const kind of REQUIREMENT_KINDS) {
  const required = E2E_REQUIREMENTS.filter((requirement) => requirement.kind === kind).length;
  console.log(`E2E ${kind} requirements: ${required}/${required} mapped.`);
}
