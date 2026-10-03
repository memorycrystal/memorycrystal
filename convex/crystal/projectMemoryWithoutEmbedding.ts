/**
 * Strips the inline `embedding` field from a memory document and stamps a
 * compile-time marker so callers cannot accidentally write the stripped doc
 * back into Convex (the schema validator rejects unknown fields).
 *
 * Use ONLY on hot read paths where the inline embedding is not needed
 * (e.g. recall list, dashboard). Vector search reads embeddings via the
 * vector index, not via inline doc fields, so it is unaffected.
 */
export type EmbeddingStrippedMemory<T> = Omit<T, "embedding"> & {
  readonly __embeddingStripped: true;
};

export function projectMemoryWithoutEmbedding<T extends { embedding?: unknown }>(
  doc: T,
): EmbeddingStrippedMemory<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { embedding: _stripped, ...rest } = doc;
  return Object.assign(rest, { __embeddingStripped: true as const }) as EmbeddingStrippedMemory<T>;
}
