import { expect, test } from "vitest";
import { OPERATION_IDS } from "./headscale-operations";

test("keeps operation identifiers unique for runtime coverage reconciliation", () => {
  expect(new Set(OPERATION_IDS).size).toBe(OPERATION_IDS.length);
});
