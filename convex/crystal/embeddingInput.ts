/**
 * Production embedding-input builders (ILL-304 / Recall v2 R1).
 *
 * `embedMemory` hashes and caches `getMemoryEffectiveText` (already trimmed).
 * The provider request then trims again. Recall queries are trimmed before
 * `embedText`, and the provider trims that string again. These helpers are the
 * exact provider input. Production and the eval recorder both use them.
 */
import { sha256Hex } from "./crypto";
import { getMemoryEffectiveText } from "./memoryText";

/** Bump when the provider input text changes. Recorded fixtures bind to it. */
export const EMBEDDING_INPUT_BUILDER_VERSION = "recall-v2-r1-v1";

export const EVAL_RECORDING_MODEL = "google/gemini-embedding-2-preview";

/** Provider `input` string. Trim is idempotent, matching embeddings.ts. */
export function finalizeEmbeddingInput(text: string): string {
  return text.trim();
}

export function buildMemoryEmbeddingInput(memory: {
  content?: string | null;
  summary?: string | null;
  recallText?: string | null;
  rawContentWipedAt?: number | null;
}): string {
  return finalizeEmbeddingInput(getMemoryEffectiveText(memory));
}

export function buildRecallQueryEmbeddingInput(query: string): string {
  return finalizeEmbeddingInput(query);
}

/** sha256(model | builderVersion | exactInputText). */
export async function embeddingFixtureKey(
  model: string,
  builderVersion: string,
  exactInputText: string,
): Promise<string> {
  return sha256Hex(`${model}|${builderVersion}|${exactInputText}`);
}
