# Organic Memory -- Full Engineering Brief for Marcus

**Classification:** CONFIDENTIAL -- Do not discuss in public channels
**From:** Gerald Sterling (Chief of Staff)
**Date:** March 28, 2026
**Approved by:** Andy Doucet

---

## TL;DR

Organic Memory is a secret addon for Memory Crystal that adds anticipatory cognition -- it predicts what users will need before they ask, detects contradictions, and finds hidden patterns across distant memories. You're building it inside the existing MC codebase (`illumin8ca/memorycrystal`). Same Convex project, same deployment. Start with foundation work, then the v1 tick loop.

---

## 1. What Is Organic Memory?

Memory Crystal today is a smart librarian -- it stores, retrieves, and enriches memories. Organic Memory turns it into a prepared operator that thinks continuously in the background.

**Core capability:** A **tick loop** -- a background process that fires on cadence, scans recent memory activity, predicts what the user will need next, and writes **prospective traces** (pre-computed context, predicted queries, flagged contradictions, detected patterns) back into MC.

**Product relationship:**
- **Memory Crystal** = the memory layer (stores, retrieves, enriches, serves). Ships today. Open source base.
- **Organic Memory** = the cognition addon. Reads from MC, writes prospective traces to MC, runs on a tick loop. Closed source. THIS project.
- MC works without Organic Memory. Organic Memory requires MC.

**Integration surface -- Organic Memory needs exactly three things from MC:**
1. **Read memories** -- via MC's existing recall/search API
2. **Write prospective traces** -- new memory type added to MC's Convex schema
3. **Receive activity signals** -- events when memories are stored, recalled, or expired

MC doesn't need to know Organic Memory exists. It just sees an API consumer.

---

## 2. Where It Lives

- **Repo:** `illumin8ca/memorycrystal` (existing private repo -- build it in there)
- **Convex project:** Same project, same deployment, same tables as MC
- **No new infrastructure** for v1-v2. Convex scheduled functions + external model API calls.
- **PRD (full doc):** https://docs.google.com/document/d/1HHvjdJbUVKIxGIIXy6XaQ83hCe1JiWivAXgDnQKhhU4/edit
- **Local PRD copy:** `/Users/gerald/projects/organic-memory/PRD-Organic-Memory.md`
- **This brief:** `/Users/gerald/projects/organic-memory/MARCUS-BRIEF.md`

---

## 3. Secrecy Rules

This is non-negotiable:

- Organic Memory is a **SECRET** addon to Memory Crystal
- Do NOT mention it in public channels (Discord, GitHub issues, etc.)
- Do NOT reference it in commit messages to public repos
- Piper must NOT leak any information through X or Reddit
- All work happens in `illumin8ca/memorycrystal` (private repo)
- All discussion happens in `#memorycrystal` Discord channel
- If anyone outside the team asks about anticipatory memory features, deflect

---

## 4. Architecture

### The Tick Loop (Core Primitive)

Everything runs on a **tick** -- a discrete cognition cycle. Each tick:

1. **Read:** What memories were stored/recalled/expired since last tick?
2. **Think:** Given recent activity + memory state, what should be anticipated?
3. **Write:** Store prospective traces (predicted queries, pre-assembled context, flagged contradictions)
4. **Expire:** Retire traces past TTL
5. **Score:** Update confidence on existing traces based on whether predictions landed

Tick frequency IS the product differentiator:
- Starter: 1 tick/hour (24 ticks/day)
- Pro: 1 tick/minute (1,440 ticks/day)
- Enterprise: 1 tick/second (86,400 ticks/day)

### The Crystalline Lattice (Endgame, v3+)

Three layers (not needed for v1-v2, but design with this in mind):

1. **Memory Nodes (lattice points)** -- each cluster (5-50 memories) gets its own small model (1.5B-3B). Sees only its local neighborhood.
2. **Orchestrator Layer (lattice bonds)** -- routes queries, aggregates node outputs, detects cross-node resonance/contradiction.
3. **Synthesis Layer (crystal face)** -- single top-tier model (Opus/GPT-5.4) receives pre-chewed lattice output. Tiny context needed.

### Model Selection

| Role | v1 (Now) | Endgame | Cost/activation |
|------|----------|---------|-----------------|
| Tick Agent | Gemini 2.5 Flash / Sonnet 4.5 | N/A (replaced by lattice) | $0.005-0.016 |
| Node | N/A (v3+) | Gemini Flash Lite / Haiku / Spark / self-hosted 1.5B-3B | $0.001-0.01 |
| Orchestrator | N/A (v3+) | Gemini 2.5 Flash / Sonnet | $0.05-0.20 |
| Synthesis | N/A (v4+) | Opus / GPT-5.4 | $0.10-0.50 |

### Scaling Properties
- No single model needs large context (50 memories per node max)
- More memories = more nodes, not bigger context (horizontal scaling)
- More nodes = more intelligence (emergent cross-node patterns)
- Embarrassingly parallel (node activations are independent)

---

## 5. Prospective Trace Schema (New Convex Table)

This is the core data structure. Add this to MC's Convex schema.

```typescript
// convex/schema.ts addition
prospectiveTraces: defineTable({
  // Identity
  userId: v.id("users"),
  createdAt: v.number(),
  tickId: v.string(),
  
  // Prediction
  predictedQuery: v.string(),
  predictedContext: v.string(),
  traceType: v.union(
    v.literal("query"),
    v.literal("context"),
    v.literal("contradiction"),
    v.literal("action"),
    v.literal("resonance")
  ),
  
  // Confidence & Lifecycle
  confidence: v.number(),          // 0.0-1.0
  expiresAt: v.number(),           // TTL timestamp
  validated: v.optional(v.union(v.boolean(), v.null())), // null=pending, true=used, false=expired
  validatedAt: v.optional(v.number()),
  
  // Sourcing
  sourceMemoryIds: v.array(v.id("memories")),
  sourcePattern: v.string(),       // human-readable reasoning
  
  // Scoring
  accessCount: v.number(),
  usefulness: v.number(),          // 0.0-1.0
  
  // Lattice metadata (v3+, optional for now)
  nodeId: v.optional(v.string()),
  orchestratorId: v.optional(v.string()),
  resonanceCluster: v.optional(v.string()),
})
  .index("by_userId", ["userId"])
  .index("by_userId_traceType", ["userId", "traceType"])
  .index("by_expiresAt", ["expiresAt"])
  .index("by_userId_validated", ["userId", "validated"])
  .index("by_tickId", ["tickId"]),
```

### Trace Types

| Type | What It Predicts | Example |
|------|-----------------|---------|
| query | Likely next question | "User will probably ask about the deployment timeline next" |
| context | Pre-assembled context bundle | "Here are the 5 most relevant memories for the meeting starting in 30 min" |
| contradiction | Detected conflict between memories | "Memory A says budget is $50K but Memory B says $75K" |
| action | Predicted pending action | "User mentioned calling Bob but hasn't logged doing it" |
| resonance | Pattern across distant memories | "Three separate conversations over 2 weeks all point to team burnout" |

### Lifecycle

```
Created (tick) -> Pending -> Served (matched to a query) -> Validated/Expired
                    |
                  TTL expires -> Expired (unvalidated)
```

---

## 6. MC Foundation Work (Build First)

These changes ship into MC's codebase first. They're useful standalone AND required for Organic Memory.

### 6a. Activity Events

MC emits events when memories are stored, recalled, or expired. Organic Memory subscribes.

**Implementation:** Internal Convex function hooks (not external webhooks for v1).

```typescript
// New table
activityLog: defineTable({
  type: v.union(
    v.literal("memory_stored"),
    v.literal("recall_triggered"),
    v.literal("memory_expired"),
    v.literal("memory_updated")
  ),
  userId: v.id("users"),
  memoryId: v.optional(v.id("memories")),
  query: v.optional(v.string()),
  resultCount: v.optional(v.number()),
  timestamp: v.number(),
  metadata: v.optional(v.any()),
})
  .index("by_timestamp", ["timestamp"])
  .index("by_userId_timestamp", ["userId", "timestamp"])
  .index("by_type_timestamp", ["type", "timestamp"]),
```

Hook into existing memory operations:
- `afterMemoryStore(ctx, memory)` -> emit `memory_stored` event
- `afterRecall(ctx, query, results)` -> emit `recall_triggered` event
- `afterMemoryExpire(ctx, memoryId)` -> emit `memory_expired` event

### 6b. Memory Access Metadata

Add to existing memories table:
- `lastAccessedAt: v.optional(v.number())` -- updated on every recall that returns this memory
- `accessCount: v.optional(v.number())` -- incremented on every access
- `updatedAt: v.number()` -- indexed for efficient "what changed since last tick" queries

These are optional fields -- no breaking changes to existing data.

### 6c. Recall Pipeline Hook

Modify MC's recall path to check prospective traces before/alongside normal search:

```typescript
// Modified recall function (pseudocode)
async function recall(ctx, query, userId) {
  // 1. Check prospective traces (fast indexed lookup)
  const traces = await matchProspectiveTraces(ctx, query, userId);
  
  // 2. Normal recall
  const memories = await normalRecall(ctx, query, userId);
  
  // 3. Mark matched traces as served
  for (const trace of traces) {
    await ctx.db.patch(trace._id, {
      accessCount: trace.accessCount + 1,
      validated: true,
      validatedAt: Date.now(),
    });
  }
  
  // 4. Merge: traces first if high confidence, then memories
  return mergeResults(traces, memories);
}

async function matchProspectiveTraces(ctx, query, userId) {
  // Get active (non-expired, non-validated) traces for this user
  const activeTraces = await ctx.db.query("prospectiveTraces")
    .withIndex("by_userId_validated", q => 
      q.eq("userId", userId).eq("validated", null)
    )
    .filter(q => q.gt(q.field("expiresAt"), Date.now()))
    .collect();
  
  // Semantic similarity between query and trace.predictedQuery
  // Use embeddings or model-based matching
  return activeTraces.filter(t => semanticMatch(query, t.predictedQuery) > 0.75);
}
```

---

## 7. Version Roadmap

### v1.0 -- Tick Loop + Prospective Traces (Weeks 1-4, April 2026)

**Goal:** Single anticipation agent runs on a tick, reads MC activity, writes prospective traces.

**What to build:**
- Convex scheduled function that fires on configurable cadence (1/hour default)
- Reads: activity log entries since last tick
- Reads: memories stored/recalled since last tick via `ctx.db.query`
- Calls Gemini 2.5 Flash with tick context, asks it to predict next needs
- Writes 1-5 prospective traces per tick
- Auto-expires stale traces (TTL check each tick)
- Configurable tick frequency per user (1/hour, 1/min)
- Tick metadata table (tracks when last tick ran, what it processed, what it wrote)

**Implementation pseudocode:**
```typescript
// convex/organicMemory.ts
export const tick = internalAction({
  handler: async (ctx) => {
    // 1. Get last tick time
    const lastTick = await ctx.runQuery(internal.organicMemory.getLastTickTime);
    
    // 2. Get recent activity
    const recentActivity = await ctx.runQuery(
      internal.organicMemory.getActivitySince, 
      { since: lastTick }
    );
    const recentMemories = await ctx.runQuery(
      internal.organicMemory.getMemoriesUpdatedSince,
      { since: lastTick }
    );
    
    // 3. Build tick context
    const tickContext = buildTickContext(recentActivity, recentMemories);
    
    // 4. Call anticipation model (external API)
    const predictions = await callAnticipationModel(tickContext);
    
    // 5. Write prospective traces
    for (const prediction of predictions) {
      await ctx.runMutation(internal.organicMemory.writeTrace, {
        predictedQuery: prediction.query,
        predictedContext: prediction.context,
        traceType: prediction.type,
        confidence: prediction.confidence,
        ttlMs: prediction.ttlMs,
        sourceMemoryIds: prediction.sourceIds,
        sourcePattern: prediction.reasoning,
      });
    }
    
    // 6. Expire old traces
    await ctx.runMutation(internal.organicMemory.expireTraces);
    
    // 7. Record tick metadata
    await ctx.runMutation(internal.organicMemory.recordTick, {
      processedEvents: recentActivity.length,
      tracesWritten: predictions.length,
      tracesExpired: expiredCount,
    });
    
    // 8. Schedule next tick
    await ctx.scheduler.runAfter(tickIntervalMs, internal.organicMemory.tick);
  },
});
```

**Success criteria:**
- Hit rate >15% (1 in 7 queries served by a prospective trace)
- Cost per tick <$0.01 at 1/min with Gemini Flash
- No latency impact on MC recall when traces miss
- Traces feel useful to a human evaluator

### v1.1 -- Trace Serving & Validation (Weeks 5-6, May 2026)

- Modified recall pipeline checks traces before normal search
- If trace matches (semantic similarity > 0.75), serve alongside results
- Mark served traces as validated; track usefulness
- Simple dashboard: trace hit rate, top predictions, confidence distribution
- False positive rate <30%

### v2.0 -- Memory Ensembles (Weeks 7-12, June-July 2026)

- Cluster related memories into ensembles (clusters, motifs, conflict groups, trajectories, project arcs, unresolved threads)
- Enhanced tick: model reasons over ensembles, not individual memories
- Initial clustering: embedding similarity >0.85, refined by tick agent each pass
- New `ensembles` table in Convex

### v2.1 -- Contradiction & Resonance Engine (Weeks 13-16, August 2026)

- Contradiction scanner: each tick checks for conflicts within/across ensembles
- Resonance scanner: finds weak reinforcing signals across distant ensembles
- Proactive alerts when confidence exceeds threshold
- Contradiction precision >85%, resonance usefulness >50%

### v3.0+ -- The Lattice (Weeks 17+, September 2026+)

Distributed node models, orchestrator layer, synthesis layer. Requires self-hosted inference or dedicated GPU. Details in the full PRD.

---

## 8. Current Infrastructure Ceiling

What runs on current Convex + Railway + API calls (no new hardware):

| Phase | Works? | Notes |
|-------|--------|-------|
| v1.0 Tick Loop | YES | Convex scheduled function + Gemini API |
| v1.1 Trace Serving | YES | Indexed query, <10ms overhead |
| v2.0 Ensembles | YES | More model calls per tick, still within 10-min Convex timeout |
| v2.1 Contradiction/Resonance | YES | Parallelize with `Promise.all` for 50+ calls |
| v3.0 Lattice | PARTIAL | Cloud nodes work (parallel API calls), no persistent model state |
| v3.1 1 tick/sec | NO | Needs dedicated inference (Mac Studio or GPU server) |

**v2.1 is the ceiling on pure serverless + API.** That's still ahead of every competitor.

---

## 9. Competitive Landscape

Nobody has built this yet. Here's who's closest:

### Tier 1: Well-Funded but Retrospective Only
- **Mem0** -- $24M raised (YC, Peak XV). 41K GitHub stars. Graph memory + vector store. No anticipatory features.
- **Cognee** -- $7.5M seed (Pebblebed). Open-source memory layer with knowledge graphs. Enterprise clients (Bayer). No prospective memory.
- **Zep/Graphiti** -- Temporal knowledge graph. Entity extraction, temporal reasoning. No anticipation.
- **Letta** -- Stateful agents with self-editing memory. Agent framework, not memory cognition layer.

### Tier 2: Closest Competitors
- **Kumiho** -- Graph-native cognitive memory with belief revision semantics. HAS "prospective indexing" (write-time future-scenario implications). 93.3% on LoCoMo-Plus. Patent pending. BUT: write-time enrichment only, not runtime anticipatory reasoning. Different thing entirely.
- **MemU (NevaMind-AI)** -- Open-source. Markets "proactive 24/7 agents" with user intention prediction. BUT: appears early-stage, thin execution, behavioral analytics not deep memory inference.
- **MemOS 2.0 (MemTensor)** -- Has "intent-aware scheduling" and "async memory preloading." BUT: infrastructure-level prefetching, not cognitive anticipation.

### Tier 3: Adjacent
- **Memories.ai** -- $8M. Visual memory for wearables/robotics. Different domain.
- **OpenMemory (Cavira)** -- Local cognitive memory, 5 sectors. No anticipatory features.
- **0GMem** -- 96.58% on LoCoMo. Pure retrospective.

### Key Research Papers
- "Can We Predict the Next Question?" (arxiv 2511.12949)
- "Speculative Actions" (arxiv 2510.04371)
- Kumiho paper (arxiv 2603.17244)
- "ContextAgent" (arxiv 2505.14668)
- "Memory in the Age of AI Agents" survey (arxiv 2512.13564)

### The Verdict
The full "prospective memory engine" is **unclaimed territory**. Kumiho has closest technical foothold (write-time). MemU has closest marketing positioning (thin execution). Nobody builds the runtime anticipatory reasoning loop. We'd be first.

---

## 10. Morrow Marriage -- Beta Test

Proposed first beta for Organic Memory v1:

**What exists today:** Cass (marriage coaching AI) runs on Railway via OpenClaw, with Memory Crystal as backend. 29 real clients with profiles, coaching notes, goals, session histories. Channel scope: `morrow-coach`.

**What Organic Memory adds:**
1. **Pattern detection across clients** -- tick notices "4 out of 29 clients dealing with reactive anger this month" without anyone asking
2. **Trajectory prediction** -- "Client X had a breakthrough 2 weeks ago but matches the regression pattern from Clients Y and Z at the same stage"
3. **Contradiction detection** -- "Client says wife is 'fully on board' but 3 sessions ago said she 'doesn't see the point'"
4. **Timing-based anticipation** -- "Client's anniversary is next week, similar clients have breakthrough moments or crises around anniversaries"
5. **Cross-client learning** -- "The communication exercise that worked for Clients A, B, and C all had a common precondition that Client D currently matches"

**Why this is an ideal beta:**
- Small memory footprint (~1,500 memories) -- cheap to run
- High value per insight -- one good anticipation could save a marriage
- Closed domain -- coaching is bounded, easier to validate
- Built-in feedback loop -- coach sees predictions, confirms/denies
- Already on MC -- zero migration needed

---

## 11. Technology Gap Analysis (Full Endgame)

What today's technology can build vs. what needs breakthroughs:

| Technology | Status (March 2026) | Needed For | ETA |
|-----------|-------------------|-----------|-----|
| Sub-millisecond model inference | Groq at ~40ms, need <10ms | 1 tick/sec at 1000+ nodes | 2028-2030 |
| Persistent model state | Google context caching is early | No cold start between ticks | 2027-2029 |
| Self-organizing model topology | Academic research only | Adaptive lattice structure | 2030+ |
| Sub-cent inference at scale | Costs dropping ~10x/year | Economic viability at 1/sec | 2026-2027 |
| Model-to-model direct communication | HPC only (NVLink, InfiniBand) | Lattice inter-node signaling | 2027-2028 |
| Efficient contradiction detection | KG research, O(n^2) problem | Scale past 100K memories | 2027-2028 |

**Bottom line:** v1-v3 are buildable with today's tech. v4-v5 need some breakthroughs. v6 (self-improving loop) is 2030+. Design the architecture now to absorb breakthroughs as they arrive.

---

## 12. Node Tiering Architecture (100x Multiplier)

For when we reach v3+ and need self-hosted inference. Not needed now, but design-relevant.

Instead of loading every node into RAM (caps at ~160 on 192GB Mac Studio):

**Tier 1: Hot Nodes** -- 25-30 loaded 1.5B Q4 models (~25GB). <50ms activation.
**Tier 2: Warm Nodes** -- 200-500 semantic signatures (~1MB). Promote to hot in 1-2s.
**Tier 3: Cold Nodes** -- 15,000+ embedding index (~500MB). Background discovery.
**Semantic Router** -- 1 permanent 1.5B model (~0.9GB) as traffic controller.

Result: 192GB Mac Studio handles **750K+ memories** instead of 8,000.

At 1B memories: 20M clusters, ~100GB RAM + 15GB SSD (cold tier on NVMe).

---

## 13. Cost Projections

### Per-Tick Cost (v1, Cloud API)

| Model | Input (~2K tokens) | Output (~500 tokens) | Total/tick |
|-------|-------------------|---------------------|-----------|
| Gemini 2.5 Flash | $0.003 | $0.002 | ~$0.005 |
| Gemini 2.0 Flash | $0.001 | $0.001 | ~$0.002 |
| Sonnet 4.5 | $0.006 | $0.010 | ~$0.016 |

### Monthly Cost by Tier

| Tier | Tick Rate | Ticks/Day | Model | Cost/Month |
|------|-----------|-----------|-------|-----------|
| Starter | 1/hour | 24 | Gemini 2.0 Flash | ~$1.50 |
| Pro | 1/min | 1,440 | Gemini 2.5 Flash | ~$216 |
| Enterprise | 1/sec | 86,400 | Gemini 2.5 Flash | ~$12,960 |

With batching/caching/delta processing, real costs estimated at 30-50% of theoretical.

---

## 14. Success Metrics

### v1 Targets
- **Anticipation hit rate:** >15% (1 in 7 queries served by a trace)
- **Cost per tick:** <$0.01 at 1/min with Flash
- **Trace precision:** >25% of generated traces eventually validated
- **Latency overhead:** <50ms added to recall
- **Trace diversity:** even distribution across trace types

### v2 Targets
- **Contradiction detection rate:** >80%
- **Resonance quality:** >50% rated "useful" by humans
- **Ensemble coherence:** >90% agreement with human labels
- **False alarm rate:** <20%

---

## 15. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-27 | OMG Engine is separate product from MC | Different buyers, infra, failure modes |
| 2026-03-28 | Renamed to "Organic Memory" | Simpler positioning |
| 2026-03-28 | Tick-rate as pricing axis | Cognition frequency = product tier |
| 2026-03-28 | v1 = single tick agent | Ship simple, validate thesis |
| 2026-03-28 | Runs as Convex scheduled function | Minimizes infra, uses MC backend |
| 2026-03-28 | Schema changes in MC, not external | Tight integration |
| 2026-03-28 | Closed source | Lattice architecture is the moat |
| 2026-03-28 | Build in `illumin8ca/memorycrystal` | Same repo, same Convex project |
| 2026-03-28 | Functionality first, pricing later | Andy's directive |
| 2026-03-28 | Morrow Marriage as v1 beta | 29 clients, small footprint, high value |

---

## 16. Your Instructions

Andy says: build whatever is realistic with sub-agents and phases. You have full autonomy on implementation approach.

**Recommended order:**
1. MC Foundation: activity events table + hooks
2. MC Foundation: memory access metadata (`lastAccessedAt`, `accessCount`, `updatedAt`)
3. MC Foundation: prospective traces table
4. v1.0: tick loop scheduled function (1/hour default)
5. v1.0: anticipation model integration (Gemini 2.5 Flash)
6. v1.0: trace writing and auto-expiry
7. v1.1: recall pipeline hook (check traces on recall)
8. v1.1: trace validation and scoring
9. Test with Morrow Marriage data
10. Iterate

**Key constraints:**
- All schema additions must be backward-compatible (optional fields, new tables)
- No breaking changes to existing MC users
- Convex action timeout is 10 minutes -- plan tick execution within that
- Use `Promise.all` for parallel model API calls where possible
- Test each foundation piece independently before building on it

Questions? Bring them to `#memorycrystal`. Let's build this.

---

*Brief compiled by Gerald Sterling, March 28, 2026.*
