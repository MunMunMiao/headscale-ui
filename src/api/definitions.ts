import type { AnyStruct } from "@defjs/core";

/** The data half of a defjs operation; the library keeps its callable half type-only. */
export type DefinitionMeta = {
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly output?: AnyStruct;
};

const definitions = new Map<string, DefinitionMeta>();

/** Called once per exported endpoint while requests.ts initializes. */
export function registerDefinition(
  name: string,
  definition: DefinitionMeta,
): void {
  definitions.set(name, definition);
}

/** Reads an endpoint's definition without executing it. Valid endpoint names always resolve. */
export function definitionOf(name: string): DefinitionMeta {
  const definition = definitions.get(name);
  if (!definition)
    throw new Error(`No defjs definition registered for "${name}"`);
  return definition;
}
