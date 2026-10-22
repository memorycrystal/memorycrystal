/** Byte estimates shared with the pre-extraction mcpRecall debits. */
import { COST_UNIT_BYTES } from "../recallBudgetPolicy";
export const ESTIMATED_RECALL_VECTOR_BYTES = COST_UNIT_BYTES.vectorQuery;
export const ESTIMATED_KB_VECTOR_BYTES = COST_UNIT_BYTES.vectorQuery;
export const ESTIMATED_TEXT_INDEX_BYTES = COST_UNIT_BYTES.textIndexQuery;

export function normalRecallVectorDepth(limit: number): number {
  const requestedLimit = Math.min(Math.max(limit, 1), 20);
  return Math.min(Math.max(requestedLimit * 4, 12), 80);
}
