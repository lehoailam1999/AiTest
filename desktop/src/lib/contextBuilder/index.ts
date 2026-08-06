/**
 * Phase 4 — Context Builder (Index → Retrieve → read Top-K → packet).
 */
export { UNIT_INDEX_BUDGET, E2E_INDEX_BUDGET, trimChars } from "./budgets";
export type { IndexContextBudget } from "./budgets";
export { buildIndexBackedContext } from "./buildFromRetrieve";
export type { BuildIndexContextInput, IndexBackedContextResult } from "./buildFromRetrieve";
