/**
 * ILL-1177: stored shape of one Memory health snapshot.
 *
 * Counts, timings, ids and scores only. Never memory text, query text or a
 * title. Every section is optional: a section that a step could not collect is
 * absent and its rubric categories score null ("not measured").
 */
import { v, type Infer } from "convex/values";

const storeSection = v.object({
  activeMemories: v.number(),
  knowledgeBaseMemories: v.number(),
  archivedMemories: v.number(),
  activeRecalledMemories: v.optional(v.number()),
  totalMessages: v.number(),
  lastCaptureAt: v.optional(v.number()),
});

const stmSection = v.object({
  pendingExtraction: v.number(),
  /** True when the pending count stopped at the read cap; the real backlog is at least this large. */
  pendingCapped: v.boolean(),
  oldestPendingAt: v.optional(v.number()),
  lastMessageAt: v.optional(v.number()),
});

const recallSection = v.object({
  days: v.number(),
  recalls: v.number(),
  emptyRecalls: v.number(),
  latencyBuckets: v.array(v.number()),
  returnedChars: v.number(),
  returnedMemories: v.number(),
  rerankRuns: v.number(),
  rerankCandidates: v.number(),
  rerankKept: v.number(),
  rerankAbstained: v.number(),
  rerankFallbacks: v.number(),
});

const sampleSection = v.object({
  /** Active non-KB memories the sampler returned. */
  sampled: v.number(),
  /** Sampled rows that carry a contentHash, so an exact twin can be looked up. */
  hashed: v.number(),
  exactDuplicates: v.number(),
  /** Sampled rows searched for a near twin (one vector search each). */
  nearSearched: v.number(),
  nearDuplicates: v.number(),
  nearSkippedReason: v.optional(v.string()),
  fluff: v.number(),
});

const probeSection = v.object({
  /** One row per positive probe: the sampled memory and its rank in the top 5 (null = missed). */
  positives: v.array(v.object({ memoryId: v.string(), rank: v.union(v.number(), v.null()) })),
  /** One row per nonsense probe: how many memories recall returned. 0 is the right answer. */
  negatives: v.array(v.object({ returned: v.number() })),
  skippedReason: v.optional(v.string()),
  embeddingCalls: v.number(),
  recallRuns: v.number(),
});

const costSection = v.object({
  days: v.number(),
  providerCalls: v.number(),
  embedCalls: v.number(),
  generateCalls: v.number(),
  inputChars: v.number(),
  /** This page's own probe embeddings, taken out of the counts above. */
  probeCallsExcluded: v.optional(v.number()),
  estimatedUsd: v.number(),
});

/** What the snapshot itself cost: the cron cost the PR has to state. */
const workSection = v.object({
  functionCalls: v.number(),
  docsRead: v.number(),
  bytesRead: v.number(),
  vectorSearches: v.number(),
  embeddingCalls: v.number(),
  recallRuns: v.number(),
});

export const memoryHealthMetrics = v.object({
  store: v.optional(storeSection),
  stm: v.optional(stmSection),
  recall: v.optional(recallSection),
  sample: v.optional(sampleSection),
  probe: v.optional(probeSection),
  cost: v.optional(costSection),
  work: v.optional(workSection),
});

export type MemoryHealthMetrics = Infer<typeof memoryHealthMetrics>;
export type MemoryHealthWork = Infer<typeof workSection>;

export const memoryHealthTrigger = v.union(v.literal("cron"), v.literal("manual"));
export const memoryHealthStatus = v.union(v.literal("running"), v.literal("complete"), v.literal("failed"));

/** Steps in run order. Each runs as its own scheduled action. */
export const MEMORY_HEALTH_STEPS = ["store", "stm", "sample", "probe"] as const;
export type MemoryHealthStep = (typeof MEMORY_HEALTH_STEPS)[number];
export const memoryHealthStep = v.union(
  v.literal("store"),
  v.literal("stm"),
  v.literal("sample"),
  v.literal("probe"),
);
