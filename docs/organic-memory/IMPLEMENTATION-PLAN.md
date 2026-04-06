# Organic Memory — Implementation Plan (v1.1, v2.0, v2.1)

**Date:** March 28, 2026
**Status:** Technical spec — ready for implementation
**Codebase:** Memory Crystal (`/Users/gerald/projects/memorycrystal`)
**Schema:** `convex/schema.ts`
**Recall pipeline:** `convex/crystal/recall.ts`

---

## Prerequisites: MC Foundation Work (Ship Before v1.1)

Before any Organic Memory version ships, these foundational changes must land in MC's codebase.

### P1. `prospectiveTraces` Table

Add to `convex/schema.ts`:

```ts
prospectiveTraces: defineTable({
  userId: v.string(),
  tickId: v.string(),
  predictedQuery: v.string(),
  predictedContext: v.string(),
  traceType: v.union(
    v.literal("query"),
    v.literal("context"),
    v.literal("contradiction"),
    v.literal("action"),
    v.literal("resonance")
  ),
  confidence: v.float64(),
  expiresAt: v.number(),
  validated: v.optional(v.boolean()),  // null-ish = pending, true = used, false = expired unused
  validatedAt: v.optional(v.number()),
  sourceMemoryIds: v.array(v.id("crystalMemories")),
  sourcePattern: v.string(),
  accessCount: v.number(),
  usefulness: v.float64(),
  embedding: v.array(v.float64()),     // embedding of predictedQuery for vector matching
  createdAt: v.number(),
})
  .index("by_user", ["userId", "createdAt"])
  .index("by_user_validated", ["userId", "validated"])
  .index("by_expires", ["expiresAt"])
  .index("by_user_type", ["userId", "traceType"])
  .vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: 3072,
    filterFields: ["userId", "traceType"],
  })
  .searchIndex("search_predicted_query", {
    searchField: "predictedQuery",
    filterFields: ["userId"],
  }),
```

### P2. `activityLog` Table

```ts
crystalActivityLog: defineTable({
  userId: v.string(),
  eventType: v.union(
    v.literal("memory_stored"),
    v.literal("memory_recalled"),
    v.literal("memory_expired"),
    v.literal("memory_archived"),
    v.literal("memory_updated")
  ),
  memoryId: v.optional(v.id("crystalMemories")),
  query: v.optional(v.string()),
  resultCount: v.optional(v.number()),
  metadata: v.optional(v.string()),
  timestamp: v.number(),
})
  .index("by_user_time", ["userId", "timestamp"])
  .index("by_event_type", ["userId", "eventType", "timestamp"]),
```

### P3. Activity Event Hooks

Add event emission calls to existing MC functions:

- **`crystal/memories.ts` — `createMemory` mutation:** After insert, write `memory_stored` event to `crystalActivityLog`.
- **`crystal/memories.ts` — `updateMemory` mutation:** After update, write `memory_updated` event.
- **`crystal/memories.ts` — `forgetMemory` mutation:** After archive/delete, write `memory_expired` event.
- **`crystal/recall.ts` — `recallMemories` action:** After building final result, write `memory_recalled` event with query text and result count.

These are fire-and-forget internal mutations — no latency impact on the calling path.

---

## v1.1 — Trace Serving in Recall Pipeline

### Goal

When MC's `recallMemories` action fires, check prospective traces for a match **before** returning. If a trace matches the incoming query, merge its `predictedContext` into the recall result. Mark the trace as validated.

### Latency Budget: <50ms Added

The trace check must not slow down recall perceptibly. We achieve this by:

1. **Vector search on `prospectiveTraces` is a single Convex `vectorSearch` call** — same as the existing memory vector search, runs in parallel with it.
2. **BM25 text search on `predictedQuery`** — same pattern as existing `searchMemoriesByText`, runs in parallel.
3. Both searches are bounded to 10 results max (traces are a small table).
4. No LLM call in the hot path. Matching is embedding similarity + text search only.

### Functions Modified

#### 1. `convex/crystal/recall.ts` — `recallMemories` action

**What changes:**

After the existing parallel block (line ~356) that runs `vectorSearch` + `searchMemoriesByText`, add a **third parallel branch** that searches prospective traces.

```ts
// Add to the existing Promise.all at line 356:
const [vectorResults, textSearchResults, traceMatches] = await Promise.all([
  // ... existing vectorSearch ...
  // ... existing textSearch ...
  // NEW: prospective trace matching
  matchProspectiveTraces(ctx, userId, args.embedding, textQuery),
]);
```

After scoring and building `finalMemories` (line ~479), merge trace results:

```ts
// After finalMemories is built, before building injection block:
const mergedResult = mergeTraceResults(finalMemories, traceMatches, normalizedLimit);
```

Before returning, validate any served traces:

```ts
// Fire-and-forget: mark served traces as validated
for (const trace of mergedResult.servedTraces) {
  await ctx.runMutation(internal.crystal.traces.markValidated, {
    traceId: trace._id,
  }).catch(() => {});
}
```

#### 2. New file: `convex/crystal/traces.ts`

Contains all prospective trace operations.

```ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// --- Trace Matching (called from recall pipeline) ---

/**
 * Vector search on prospectiveTraces table.
 * Returns traces where predictedQuery embedding is similar to incoming query.
 */
export const searchTracesByVector = internalQuery({
  args: {
    userId: v.string(),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Note: vectorSearch is only available in actions, so this will actually
    // be called differently — see matchProspectiveTraces below.
    // This query handles the post-filter after vector IDs are retrieved.
    const limit = args.limit ?? 10;
    // Fetch active (non-expired, non-validated) traces for this user
    const traces = await ctx.db
      .query("prospectiveTraces")
      .withIndex("by_user_validated", (q) =>
        q.eq("userId", args.userId).eq("validated", undefined)
      )
      .take(limit * 2);

    const now = Date.now();
    return traces.filter((t) => t.expiresAt > now);
  },
});

/**
 * BM25 text search on predictedQuery field.
 */
export const searchTracesByText = internalQuery({
  args: {
    userId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    return ctx.db
      .query("prospectiveTraces")
      .withSearchIndex("search_predicted_query", (q) =>
        q.search("predictedQuery", args.query).eq("userId", args.userId)
      )
      .take(limit);
  },
});

// --- Trace Lifecycle ---

export const markValidated = internalMutation({
  args: { traceId: v.id("prospectiveTraces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get(args.traceId);
    if (!trace || trace.validated !== undefined) return;
    await ctx.db.patch(args.traceId, {
      validated: true,
      validatedAt: Date.now(),
      accessCount: trace.accessCount + 1,
    });
  },
});

export const expireStaleTraces = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("prospectiveTraces")
      .withIndex("by_user_validated", (q) =>
        q.eq("userId", args.userId).eq("validated", undefined)
      )
      .take(200);

    for (const trace of stale) {
      if (trace.expiresAt <= now) {
        await ctx.db.patch(trace._id, {
          validated: false,
          validatedAt: now,
        });
      }
    }
  },
});
```

### Semantic Matching Strategy

**Approach: Hybrid vector + BM25, same as existing recall.**

The incoming query already has an embedding (passed as `args.embedding` to `recallMemories`). We reuse it:

1. **Vector search** on `prospectiveTraces.by_embedding` — cosine similarity between incoming query embedding and the trace's `predictedQuery` embedding. Threshold: **similarity > 0.82** (tighter than memory recall's implicit threshold, because we want high-confidence matches only).

2. **BM25 text search** on `prospectiveTraces.search_predicted_query` — catches keyword matches that embeddings miss (exact names, IDs, etc.).

3. **Combined scoring:** `traceScore = 0.6 * vectorSimilarity + 0.3 * bm25Score + 0.1 * trace.confidence`

4. **Threshold for serving:** `traceScore >= 0.70`. Below this, the trace is not served.

**Why not an LLM call for matching?** Latency. An LLM call adds 500ms-2s. Vector + BM25 matching adds <10ms. The matching doesn't need to be perfect — false negatives (missing a valid trace) just fall back to normal recall. False positives (serving a bad trace) are caught by the validation loop and degrade the trace's usefulness score over time.

### The `matchProspectiveTraces` Helper

This is a plain function called within the `recallMemories` action context:

```ts
// In recall.ts or a shared utils file

const TRACE_VECTOR_THRESHOLD = 0.82;
const TRACE_SERVE_THRESHOLD = 0.70;

const matchProspectiveTraces = async (
  ctx: any,
  userId: string,
  embedding: number[],
  textQuery: string
): Promise<TraceMatch[]> => {
  const [vectorResults, textResults] = await Promise.all([
    ctx.vectorSearch("prospectiveTraces", "by_embedding", {
      vector: embedding,
      limit: 10,
      filter: (q: any) => q.eq("userId", userId),
    }),
    textQuery.trim().length > 0
      ? ctx.runQuery(internal.crystal.traces.searchTracesByText, {
          userId,
          query: textQuery,
          limit: 10,
        })
      : Promise.resolve([]),
  ]);

  // Build score map from vector results
  const vectorScores = new Map<string, number>();
  for (const r of vectorResults) {
    if (r._score >= TRACE_VECTOR_THRESHOLD) {
      vectorScores.set(String(r._id), r._score);
    }
  }

  // Build BM25 map from text results
  const textScores = new Map<string, number>();
  for (const r of textResults) {
    textScores.set(String(r._id), 1.0); // BM25 hit = 1.0 boost
  }

  // Merge candidate IDs
  const candidateIds = new Set([
    ...vectorScores.keys(),
    ...textScores.keys(),
  ]);

  // Fetch full trace docs and score
  const now = Date.now();
  const matches: TraceMatch[] = [];

  for (const traceId of candidateIds) {
    const trace = await ctx.runQuery(internal.crystal.traces.getTrace, {
      traceId: traceId as any,
    });
    if (!trace || trace.userId !== userId) continue;
    if (trace.expiresAt <= now) continue;
    if (trace.validated !== undefined) continue; // already validated or expired

    const vecScore = vectorScores.get(traceId) ?? 0;
    const txtScore = textScores.get(traceId) ?? 0;
    const traceScore =
      0.6 * vecScore + 0.3 * txtScore + 0.1 * trace.confidence;

    if (traceScore >= TRACE_SERVE_THRESHOLD) {
      matches.push({
        _id: trace._id,
        predictedQuery: trace.predictedQuery,
        predictedContext: trace.predictedContext,
        traceType: trace.traceType,
        confidence: trace.confidence,
        sourceMemoryIds: trace.sourceMemoryIds,
        traceScore,
      });
    }
  }

  return matches.sort((a, b) => b.traceScore - a.traceScore).slice(0, 3);
};
```

### How `validated` Gets Set

| Event | `validated` value | When |
|-------|------------------|------|
| Trace created by tick | `undefined` (pending) | Tick writes the trace |
| Trace served in recall | `true` | `markValidated` mutation fires after recall returns |
| Trace expires (TTL) | `false` | `expireStaleTraces` mutation runs in tick's expire phase |

The `validated` field is `v.optional(v.boolean())`. Convex stores `undefined` for unset optional fields, which acts as our "pending" state. The index `by_user_validated` allows querying for pending traces efficiently: `.eq("validated", undefined)`.

### Merged Result Format

The recall response shape stays the same (`RecallSet`), but the injection block gains a new section when traces match:

```ts
type TraceMatch = {
  _id: string;
  predictedQuery: string;
  predictedContext: string;
  traceType: string;
  confidence: number;
  sourceMemoryIds: string[];
  traceScore: number;
};

const mergeTraceResults = (
  memories: RecallResult[],
  traces: TraceMatch[],
  limit: number
): { memories: RecallResult[]; servedTraces: TraceMatch[]; injectionBlock: string } => {
  if (traces.length === 0) {
    return {
      memories,
      servedTraces: [],
      injectionBlock: buildInjectionBlock(memories),
    };
  }

  // Build trace injection section
  const traceLines = traces.map((t) => [
    `### ANTICIPATED: ${t.predictedQuery}`,
    `*Confidence: ${t.confidence.toFixed(2)} | Match: ${t.traceScore.toFixed(2)} | Type: ${t.traceType}*`,
    t.predictedContext,
    "",
  ].join("\n"));

  const traceBlock = [
    "## Anticipated Context (Organic Memory)",
    ...traceLines,
  ].join("\n");

  const memoryBlock = buildInjectionBlock(memories);

  return {
    memories,
    servedTraces: traces,
    injectionBlock: traceBlock + "\n\n" + memoryBlock,
  };
};
```

The `RecallSet` return type gains an optional field:

```ts
type RecallSet = {
  memories: RecallResult[];
  injectionBlock: string;
  servedTraces?: TraceMatch[];  // new: which traces were served (for analytics)
};
```

---

## v2.0 — Memory Ensembles

### Goal

Group individual memories into structural units (ensembles). The tick loop reasons over ensembles instead of raw memories. Recall returns ensemble context when a cluster matches.

### New Table: `crystalEnsembles`

Add to `convex/schema.ts`:

```ts
crystalEnsembles: defineTable({
  userId: v.string(),
  ensembleType: v.union(
    v.literal("cluster"),
    v.literal("motif"),
    v.literal("conflict_group"),
    v.literal("trajectory"),
    v.literal("project_arc")
  ),
  label: v.string(),                                // human-readable name
  summary: v.string(),                              // LLM-generated summary
  memberMemoryIds: v.array(v.id("crystalMemories")),
  centroidEmbedding: v.array(v.float64()),          // average embedding of members
  strength: v.float64(),                            // aggregate strength
  confidence: v.float64(),                          // how coherent is this ensemble
  metadata: v.optional(v.string()),                 // JSON: type-specific data
  createdAt: v.number(),
  updatedAt: v.number(),
  lastTickId: v.optional(v.string()),               // which tick last processed this
  archived: v.boolean(),
})
  .index("by_user", ["userId", "archived"])
  .index("by_user_type", ["userId", "ensembleType", "archived"])
  .index("by_updated", ["userId", "updatedAt"])
  .vectorIndex("by_centroid", {
    vectorField: "centroidEmbedding",
    dimensions: 3072,
    filterFields: ["userId", "ensembleType", "archived"],
  }),
```

Add a reverse-lookup table for efficient "which ensembles contain this memory?" queries:

```ts
crystalEnsembleMemberships: defineTable({
  userId: v.string(),
  memoryId: v.id("crystalMemories"),
  ensembleId: v.id("crystalEnsembles"),
  addedAt: v.number(),
})
  .index("by_memory", ["memoryId"])
  .index("by_ensemble", ["ensembleId"])
  .index("by_user", ["userId"]),
```

### Ensemble Types — Detailed Definitions

#### 1. Clusters (semantic grouping)

**What:** 5-50 memories about the same topic, grouped by embedding similarity.

**Detection algorithm:**

```
1. Take all active memories for a user (query crystalMemories by_user, archived=false)
2. For each memory not yet in a cluster:
   a. Vector search for its 20 nearest neighbors
   b. Filter to neighbors with cosine similarity > 0.85
   c. If >= 5 neighbors pass threshold, form a cluster
   d. Compute centroid = average of all member embeddings
   e. Generate label + summary via LLM
3. For existing clusters:
   a. Check if new memories since last tick belong (similarity to centroid > 0.85)
   b. Check if existing members have drifted (similarity to centroid < 0.75) → remove
   c. If cluster drops below 3 members → archive it
   d. Recompute centroid after changes
```

**Computing cosine similarity in Convex:**

Convex's `vectorSearch` returns `_score` which IS cosine similarity for normalized vectors. We use this directly — no manual dot product needed. For comparing two specific embeddings (e.g., checking a memory against a centroid), we compute it in-process:

```ts
const cosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
```

This runs in <1ms for 3072-dimensional vectors. No external call needed.

**Batching strategy for initial clustering:**

Full clustering of all memories is expensive. We don't do it all at once. The tick loop processes **50 unclustered memories per tick**. At 1 tick/min, that's 3,000 memories/hour — more than enough to keep up with ingestion.

```ts
// Pseudocode for cluster detection in tick
const unclusteredMemories = await getUnclusteredMemories(ctx, userId, 50);
for (const memory of unclusteredMemories) {
  const neighbors = await ctx.vectorSearch("crystalMemories", "by_embedding", {
    vector: memory.embedding,
    limit: 20,
    filter: (q) => q.eq("userId", userId),
  });
  const similar = neighbors.filter((n) => n._score > 0.85 && n._id !== memory._id);
  if (similar.length >= 4) {
    // Form or merge into cluster
    await createOrMergeCluster(ctx, userId, memory, similar);
  }
}
```

#### 2. Motifs (recurring patterns)

**What:** Patterns that appear across multiple time windows. "User keeps revisiting deployment concerns every Monday."

**Detection:** The tick agent (LLM) examines clusters with temporal spread > 7 days. If members are distributed across 3+ distinct time windows, it's a motif. Stored in `metadata` JSON:

```json
{
  "recurrencePattern": "weekly",
  "peakDays": ["monday", "tuesday"],
  "firstSeen": 1711584000000,
  "lastSeen": 1714176000000,
  "occurrenceCount": 6
}
```

#### 3. Conflict Groups

**What:** 2+ memories within a cluster that make contradictory claims.

**Detection:** See v2.1 below. Conflict groups are ensembles created when the contradiction scanner finds a conflict. The ensemble captures both sides.

#### 4. Trajectories

**What:** Ordered sequence showing evolution. "Budget was $50K → then $75K → then $60K final."

**Detection:** Within a cluster, sort members by `createdAt`. If content shows progression (detected by LLM during tick), create a trajectory ensemble. Metadata:

```json
{
  "direction": "increasing" | "decreasing" | "oscillating" | "resolved",
  "milestones": [
    { "memoryId": "...", "summary": "Initial budget set at $50K", "timestamp": ... },
    { "memoryId": "...", "summary": "Revised to $75K after scope change", "timestamp": ... }
  ]
}
```

#### 5. Project Arcs

**What:** Memories tied to a specific project or goal, spanning its lifecycle.

**Detection:** Memories tagged with the same project tag, or memories that reference the same `crystalNode` of type `"project"` or `"goal"` (via `crystalMemoryNodeLinks`). The tick agent groups them and tracks arc status (active, completed, stalled).

### Tick Loop Changes for Ensembles

Currently, the tick loop (v1.0) processes individual memories. In v2.0, the tick loop shifts to a two-phase approach:

#### Phase 1: Ensemble Maintenance (runs every tick)

```ts
// convex/crystal/organicTick.ts

export const runTick = action({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const lastTickTime = await getLastTickTime(ctx, args.userId);
    const now = Date.now();

    // Phase 1: Ensemble maintenance
    // 1a. Get new memories since last tick
    const newMemories = await ctx.runQuery(
      internal.crystal.organicQueries.memoriesSince,
      { userId: args.userId, since: lastTickTime }
    );

    // 1b. Assign new memories to existing ensembles or create new ones
    for (const memory of newMemories) {
      await assignToEnsemble(ctx, args.userId, memory);
    }

    // 1c. Prune/merge ensembles that have drifted
    await pruneEnsembles(ctx, args.userId);

    // Phase 2: Anticipation (now reasons over ensembles)
    const activeEnsembles = await ctx.runQuery(
      internal.crystal.organicQueries.recentEnsembles,
      { userId: args.userId, limit: 20 }
    );

    const recentActivity = await ctx.runQuery(
      internal.crystal.organicQueries.activitySince,
      { userId: args.userId, since: lastTickTime }
    );

    // Build tick context from ensembles instead of raw memories
    const tickContext = buildEnsembleTickContext(activeEnsembles, recentActivity);

    // Call anticipation model — now reasons about clusters, trajectories, etc.
    const predictions = await callAnticipationModel(tickContext);

    // Write prospective traces
    for (const prediction of predictions) {
      await ctx.runMutation(internal.crystal.traces.createTrace, {
        userId: args.userId,
        tickId: `tick_${now}`,
        ...prediction,
      });
    }

    // Expire stale traces
    await ctx.runMutation(internal.crystal.traces.expireStaleTraces, {
      userId: args.userId,
    });

    // Record tick time
    await ctx.runMutation(internal.crystal.organicState.setLastTickTime, {
      userId: args.userId,
      timestamp: now,
    });
  },
});
```

#### Phase 2: Ensemble-Aware Anticipation Prompt

The LLM prompt shifts from "here are 20 recent memories" to:

```
You are the anticipation engine for a memory system. Given the following memory ensembles and recent activity, predict what the user will need next.

## Active Ensembles

### Cluster: "Q2 Budget Planning" (8 memories, strength: 0.87)
Summary: User has been discussing budget allocation across engineering and marketing...
Recent activity: 3 new memories added in last 2 hours
Trajectory: Budget figures increasing (50K → 75K → discussing 80K)

### Motif: "Monday Deployment Reviews" (12 memories, recurring weekly)
Summary: User reviews deployment status every Monday morning...
Next expected: Monday March 30, 2026

### Conflict Group: "API Migration Timeline" (4 memories)
Summary: Conflicting dates for API v2 migration — some memories say April, others say June
Status: Unresolved

## Recent Activity
- 4 memories stored (2 about budget, 1 about hiring, 1 about API)
- 2 recalls triggered (both about budget)
- 1 memory archived

## Task
Generate 1-5 prospective traces. For each, provide:
- predictedQuery: what the user will likely ask
- predictedContext: pre-assembled answer/context
- traceType: query | context | contradiction | action | resonance
- confidence: 0.0-1.0
- sourcePattern: why you predicted this
- ttlMs: how long this prediction stays valid
```

### Recall Changes for Ensemble Context

When a recall query matches an ensemble's centroid, return the ensemble's summary and key members alongside individual memory results.

**Modification to `recallMemories` in `recall.ts`:**

After building `finalMemories`, add ensemble lookup:

```ts
// After finalMemories is built (line ~479 in current recall.ts)

// Look up ensembles that match the query
const ensembleMatches = await matchEnsembles(ctx, userId, args.embedding, 5);

// For high-confidence ensemble matches, inject ensemble context
const ensembleContext = ensembleMatches
  .filter((e) => e.matchScore > 0.80)
  .map((e) => ({
    ensembleId: e._id,
    label: e.label,
    summary: e.summary,
    ensembleType: e.ensembleType,
    memberCount: e.memberMemoryIds.length,
    matchScore: e.matchScore,
  }));
```

The `matchEnsembles` function:

```ts
const matchEnsembles = async (
  ctx: any,
  userId: string,
  embedding: number[],
  limit: number
) => {
  const results = await ctx.vectorSearch("crystalEnsembles", "by_centroid", {
    vector: embedding,
    limit,
    filter: (q: any) => q.eq("userId", userId),
  });

  // Fetch full docs
  return Promise.all(
    results.map(async (r: any) => {
      const doc = await ctx.runQuery(
        internal.crystal.ensembles.getEnsemble,
        { ensembleId: r._id }
      );
      return { ...doc, matchScore: r._score };
    })
  ).then((docs) => docs.filter((d) => d && !d.archived));
};
```

Ensemble context gets added to the injection block:

```
## Memory Ensembles
### Cluster: "Q2 Budget Planning" (8 memories, match: 0.91)
Budget discussions for Q2 have been escalating. Initial figure was $50K, revised to $75K
after scope expansion. Most recent discussion suggests $80K ceiling...

## Memory Crystal Memory Recall
### SEMANTIC: Q2 Budget Proposal
...
```

---

## v2.1 — Contradiction & Resonance Engine

### Goal

Actively detect contradictions between memories and resonance patterns across distant clusters. Surface findings proactively without spamming.

### Contradiction Detection

#### Model Prompt for Conflict Scoring

Given two memories from the same ensemble (or overlapping ensembles), the LLM evaluates conflict:

```
You are a contradiction detector. Given two memories from the same user's memory system, determine if they contradict each other.

Memory A:
Title: {{titleA}}
Content: {{contentA}}
Created: {{createdAtA}}

Memory B:
Title: {{titleB}}
Content: {{contentB}}
Created: {{createdAtB}}

Score the contradiction on this scale:
- 0.0: No contradiction. Compatible or unrelated.
- 0.3: Minor tension. Different emphasis but not conflicting.
- 0.6: Moderate contradiction. Claims that can't both be fully true.
- 0.9: Direct contradiction. Mutually exclusive claims.
- 1.0: Factual conflict. Explicit opposite statements about the same thing.

Respond in JSON:
{
  "score": <number>,
  "explanation": "<one sentence explaining the conflict or lack thereof>",
  "conflictType": "factual" | "temporal" | "opinion" | "scope" | "none",
  "suggestedResolution": "<optional: how to resolve if score > 0.5>"
}
```

#### Avoiding O(n^2) Blowup

Naive approach: compare every memory pair = O(n^2). For 10K memories, that's 50M comparisons. Impossible.

**Strategy: Ensemble-scoped scanning with temporal windowing.**

1. **Only scan within ensembles.** Contradictions between unrelated memories are noise. Contradictions within a cluster are actionable. If a cluster has 20 members, that's 190 pairs — manageable.

2. **Only scan new-vs-existing.** Each tick, only compare memories added since last tick against existing ensemble members. If 3 new memories landed in a 20-member cluster, that's 3 * 20 = 60 comparisons, not 190.

3. **Pre-filter with embedding dissimilarity.** Within a cluster, memories with very high similarity (>0.95) are almost certainly not contradictions — they're reinforcing. Only check pairs with similarity in the 0.70-0.90 range (related enough to be about the same thing, different enough to potentially conflict).

4. **Budget per tick.** Cap at 20 LLM contradiction checks per tick. At $0.005/check, that's $0.10/tick max.

```ts
// Pseudocode for contradiction scanning in tick

const contradictionBudget = 20;
let checksRemaining = contradictionBudget;

const modifiedEnsembles = await getEnsemblesModifiedSince(ctx, userId, lastTickTime);

for (const ensemble of modifiedEnsembles) {
  if (checksRemaining <= 0) break;

  const newMembers = ensemble.memberMemoryIds.filter(
    (id) => getMemoryCreatedAt(id) > lastTickTime
  );
  const existingMembers = ensemble.memberMemoryIds.filter(
    (id) => getMemoryCreatedAt(id) <= lastTickTime
  );

  for (const newMem of newMembers) {
    for (const existingMem of existingMembers) {
      if (checksRemaining <= 0) break;

      // Pre-filter: skip very similar pairs (reinforcing, not contradicting)
      const sim = cosineSimilarity(newMem.embedding, existingMem.embedding);
      if (sim > 0.95 || sim < 0.70) continue;

      // LLM contradiction check
      const result = await checkContradiction(newMem, existingMem);
      checksRemaining--;

      if (result.score >= 0.6) {
        // Create conflict_group ensemble if not already one
        await createOrUpdateConflictGroup(ctx, userId, newMem, existingMem, result);

        // Create contradiction prospective trace
        await ctx.runMutation(internal.crystal.traces.createTrace, {
          userId,
          tickId: currentTickId,
          predictedQuery: `Contradiction: ${result.explanation}`,
          predictedContext: buildContradictionContext(newMem, existingMem, result),
          traceType: "contradiction",
          confidence: result.score,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h TTL for contradictions
          sourceMemoryIds: [newMem._id, existingMem._id],
          sourcePattern: `Detected ${result.conflictType} contradiction within ensemble "${ensemble.label}"`,
          accessCount: 0,
          usefulness: 0,
          embedding: averageEmbedding(newMem.embedding, existingMem.embedding),
        });
      }
    }
  }
}
```

**Complexity analysis:**
- k ensembles modified per tick (typically 1-5)
- m new memories per ensemble per tick (typically 1-3)
- n existing members per ensemble (typically 5-20)
- Pre-filter eliminates ~60-70% of pairs
- Per tick: ~5 * 3 * 15 * 0.35 = ~79 candidate pairs, capped at 20 LLM calls
- O(k * m * n) per tick, not O(N^2) over all memories

### Resonance Detection

#### What "Three Conversations Pointing to X" Means Computationally

Resonance is when multiple **distant** memory clusters independently contain signals about the same underlying theme, without the user explicitly connecting them.

**Computational definition:**
1. Take the set of all active ensembles.
2. For each ensemble, generate a **theme vector** (the centroid embedding) and a **theme summary** (1-2 sentence LLM summary).
3. Find ensemble pairs where centroids have moderate similarity (0.65-0.85). These are "related but not the same topic" — the sweet spot for resonance.
4. If 3+ ensembles in this similarity band share a common theme, it's resonance.

```ts
// Resonance detection in tick loop

const RESONANCE_SIM_LOW = 0.65;
const RESONANCE_SIM_HIGH = 0.85;
const RESONANCE_MIN_SOURCES = 3;

const detectResonance = async (
  ctx: any,
  userId: string,
  ensembles: Ensemble[]
): Promise<ResonanceCandidate[]> => {
  const candidates: ResonanceCandidate[] = [];

  // For each ensemble, find moderately-similar peers
  for (const ensemble of ensembles) {
    const peers = await ctx.vectorSearch("crystalEnsembles", "by_centroid", {
      vector: ensemble.centroidEmbedding,
      limit: 20,
      filter: (q: any) => q.eq("userId", userId),
    });

    const resonantPeers = peers.filter(
      (p: any) =>
        p._score >= RESONANCE_SIM_LOW &&
        p._score <= RESONANCE_SIM_HIGH &&
        String(p._id) !== String(ensemble._id)
    );

    if (resonantPeers.length >= RESONANCE_MIN_SOURCES - 1) {
      // Potential resonance — verify with LLM
      candidates.push({
        sourceEnsemble: ensemble,
        resonantEnsembles: resonantPeers,
        avgSimilarity:
          resonantPeers.reduce((sum: number, p: any) => sum + p._score, 0) /
          resonantPeers.length,
      });
    }
  }

  // Deduplicate (A resonates with B = B resonates with A)
  return dedupeResonanceCandidates(candidates);
};
```

The LLM then verifies: "These 3 clusters seem related. Is there a meaningful cross-cutting theme?"

```
You are a resonance detector. Given these memory clusters from the same user, determine if they share an underlying theme the user hasn't explicitly stated.

Cluster 1: "{{label1}}" — {{summary1}}
Cluster 2: "{{label2}}" — {{summary2}}
Cluster 3: "{{label3}}" — {{summary3}}

Is there a meaningful cross-cutting pattern? Respond in JSON:
{
  "isResonance": true/false,
  "theme": "<the underlying pattern>",
  "confidence": 0.0-1.0,
  "insight": "<what this means for the user>",
  "actionable": true/false
}
```

If confirmed, create a resonance prospective trace with 7-day TTL.

### Proactive Alert Mechanism

**Problem:** Don't spam the user with every contradiction and resonance.

**Solution: Tiered surfacing with a daily budget.**

```ts
// Alert thresholds
const ALERT_THRESHOLDS = {
  contradiction: {
    minConfidence: 0.75,       // only surface high-confidence contradictions
    maxPerDay: 3,              // max 3 contradiction alerts per day
    cooldownMs: 4 * 60 * 60 * 1000, // 4 hours between alerts
  },
  resonance: {
    minConfidence: 0.70,
    maxPerDay: 2,
    cooldownMs: 8 * 60 * 60 * 1000,
  },
};
```

**Surfacing channels (in priority order):**

1. **In-recall injection.** When a recall query matches a contradiction/resonance trace (via the v1.1 trace serving pipeline), it gets injected into the recall result. This is the primary channel — the user sees it when it's relevant.

2. **Proactive flag.** For high-confidence findings (>0.85) that haven't been served via recall within 12 hours, write to a `crystalAlerts` table that the MC dashboard can poll:

```ts
crystalAlerts: defineTable({
  userId: v.string(),
  alertType: v.union(v.literal("contradiction"), v.literal("resonance"), v.literal("action")),
  title: v.string(),
  body: v.string(),
  sourceTraceId: v.id("prospectiveTraces"),
  priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
  read: v.boolean(),
  createdAt: v.number(),
})
  .index("by_user_unread", ["userId", "read", "createdAt"])
  .index("by_user", ["userId", "createdAt"]),
```

3. **Never push notifications or emails for v2.1.** Alerts are pull-only (dashboard, recall injection). Push channels deferred to v3+.

**Anti-spam logic:**

```ts
const shouldSurfaceAlert = async (
  ctx: any,
  userId: string,
  alertType: "contradiction" | "resonance",
  confidence: number
): Promise<boolean> => {
  const thresholds = ALERT_THRESHOLDS[alertType];
  if (confidence < thresholds.minConfidence) return false;

  // Check daily budget
  const dayStart = startOfDay(Date.now());
  const todayAlerts = await ctx.db
    .query("crystalAlerts")
    .withIndex("by_user", (q) =>
      q.eq("userId", userId).gte("createdAt", dayStart)
    )
    .filter((q) => q.eq(q.field("alertType"), alertType))
    .collect();

  if (todayAlerts.length >= thresholds.maxPerDay) return false;

  // Check cooldown
  const lastAlert = todayAlerts[todayAlerts.length - 1];
  if (lastAlert && Date.now() - lastAlert.createdAt < thresholds.cooldownMs) {
    return false;
  }

  return true;
};
```

---

## File Structure Recommendation

All new files live in `convex/crystal/` following existing conventions.

### New Files

| File | Purpose | Export Types |
|------|---------|-------------|
| `convex/crystal/traces.ts` | Prospective trace CRUD, matching, validation | `internalMutation`, `internalQuery` |
| `convex/crystal/ensembles.ts` | Ensemble CRUD, clustering, membership | `internalMutation`, `internalQuery` |
| `convex/crystal/organicTick.ts` | The tick loop action | `action` (main), `internalMutation` (state) |
| `convex/crystal/organicQueries.ts` | Read-only queries for tick context | `internalQuery` |
| `convex/crystal/organicState.ts` | Tick state, last-tick timestamps | `internalMutation`, `internalQuery` |
| `convex/crystal/contradiction.ts` | Contradiction detection logic | `internalMutation`, `internalQuery` |
| `convex/crystal/resonance.ts` | Resonance detection logic | `internalMutation`, `internalQuery` |
| `convex/crystal/alerts.ts` | Alert creation, surfacing, anti-spam | `internalMutation`, `query` |

### Modified Files

| File | Changes |
|------|---------|
| `convex/schema.ts` | Add `prospectiveTraces`, `crystalActivityLog`, `crystalEnsembles`, `crystalEnsembleMemberships`, `crystalAlerts` tables |
| `convex/crystal/recall.ts` | Add trace matching + ensemble matching to `recallMemories` action |
| `convex/crystal/memories.ts` | Add activity event hooks to `createMemory`, `updateMemory`, `forgetMemory` |
| `convex/crons.ts` | Add tick loop cron entry |

### Naming Conventions

Following existing `crystal/` codebase patterns:

- **File names:** camelCase (`organicTick.ts`, not `organic-tick.ts`)
- **Exported functions:** camelCase (`runTick`, `markValidated`)
- **Internal functions:** prefixed with `internal.crystal.<file>.<fn>`
- **Actions** (need side effects / LLM calls): `action({ ... })`
- **Mutations** (write to DB): `internalMutation({ ... })` for internal-only, `mutation({ ... })` for API-facing
- **Queries** (read from DB): `internalQuery({ ... })` for internal-only, `query({ ... })` for API-facing
- **Scheduled actions:** registered in `crons.ts` using `crons.interval()` or `crons.daily()`

### Cron Entry for Tick Loop

Add to `convex/crons.ts`:

```ts
// Organic Memory tick loop — starter tier (1/hour)
crons.interval(
  "organic-tick",
  { hours: 1 },
  api.crystal.organicTick.runTickForAllUsers,
  {}
);
```

The `runTickForAllUsers` action iterates over users with active Organic Memory subscriptions and dispatches per-user tick actions. For Pro tier (1/min), the interval changes to `{ minutes: 1 }` — controlled by a config value, not a code change.

---

## Implementation Order

### Phase 1 — Foundation (ship into MC now)
1. Schema additions (prospectiveTraces, activityLog tables)
2. Activity event hooks in memories.ts and recall.ts
3. `traces.ts` — basic CRUD

### Phase 2 — v1.1 Trace Serving
4. `matchProspectiveTraces` in recall.ts
5. `mergeTraceResults` and injection block changes
6. Validation loop (markValidated, expireStaleTraces)
7. Integration test: create trace, run recall, verify trace served

### Phase 3 — v2.0 Ensembles
8. Schema additions (ensembles, memberships tables)
9. `ensembles.ts` — clustering algorithm
10. `organicTick.ts` — tick loop with ensemble maintenance
11. `organicQueries.ts` — tick context queries
12. Recall changes — ensemble context injection
13. Integration test: memories cluster, ensemble returned in recall

### Phase 4 — v2.1 Contradiction & Resonance
14. `contradiction.ts` — detection logic, LLM prompts
15. `resonance.ts` — cross-ensemble pattern detection
16. Schema addition (alerts table)
17. `alerts.ts` — surfacing logic, anti-spam
18. Wire into tick loop
19. Integration test: create contradicting memories, verify detection

---

*Plan authored by Gerald Sterling. March 28, 2026.*
