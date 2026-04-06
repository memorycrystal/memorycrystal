# Organic Memory — Product Requirements Document

**Product:** Organic Memory (addon for Memory Crystal)
**Author:** Andy Doucet / Gerald Sterling
**Date:** March 28, 2026 (last updated March 31, 2026)
**Status:** Active Development — v1.0 shipped, v1.1 in progress (scope expanded: fibers, ideas, notifications, trace v2)
**Classification:** Closed source (may open source later)

---

## 1. Product Overview

### What Is It?
Organic Memory is an addon for Memory Crystal that adds real thinking to your memory. It transforms MC from a passive storage/retrieval system into an active cognition layer that anticipates what you'll need, detects contradictions before they cause problems, and prepares context before you ask for it.

### Core Thesis
Today's AI memory systems are retrospective -- they search after the question arrives. Organic Memory is prospective -- it prepares before the question lands. The shift is from smart librarian to prepared operator.

### Product Relationship
- **Memory Crystal (MC)** -- the memory layer. Stores, retrieves, enriches, serves. Open source base, managed tiers. Exists and ships today.
- **Organic Memory** -- the cognition addon. Reads from MC, writes prospective traces to MC, runs on a tick loop. Closed source. This document.
- MC works without Organic Memory. Organic Memory requires MC.

### Integration Surface
Organic Memory needs exactly three things from MC:
1. **Read memories** -- via MC's existing recall/search API
2. **Write prospective traces** -- new memory type added to MC's Convex schema
3. **Receive activity signals** -- events when memories are stored, recalled, or expired

MC doesn't need to know Organic Memory exists. It just sees an API consumer.

---

## 2. Architecture

### The Tick Loop (Core Primitive)

Everything in Organic Memory runs on a **tick** -- a discrete cognition cycle. Each tick:

1. **Read:** What memories were stored/recalled/expired since last tick?
2. **Think:** Given recent activity patterns + memory state, what should be anticipated?
3. **Write:** Store prospective traces (predicted queries, pre-assembled context, flagged contradictions)
4. **Expire:** Retire prospective traces that went unvalidated past their TTL
5. **Score:** Update confidence on existing traces based on whether predictions landed

Tick frequency is the product differentiator:
- Starter: 1 tick/hour (24 ticks/day)
- Pro: 1 tick/minute (1,440 ticks/day)
- Enterprise: 1 tick/second (86,400 ticks/day)

Lower packages get lower cognition. Higher packages get a memory system that thinks faster.

### Fibers (Parallel Pulse Processing)

A single pulse spawns multiple **fibers** — parallel processing strands within one pulse cycle. Like neural fibers carrying different signals along the same nerve bundle, or mycelial fibers in a fungal network each transporting different nutrients, each fiber handles an independent concern and writes its results back before the pulse completes.

**v1.1 Fibers:**

| Fiber | Concern | Output |
|-------|---------|--------|
| Trace prediction | Anticipate next queries/needs | Prospective traces |
| Connection discovery | Find cross-memory insights | Ideas (organicIdeas) |
| Procedural extraction | Detect workflow patterns | Procedural memories |
| Content security | Scan for injection/exfiltration | Security flags, blocked writes |

**Why fibers, not sequential steps:**
- Independent concerns with no data dependencies between them
- A slow fiber (e.g., discovery scanning 500 memories) doesn't block a fast fiber (e.g., security scan)
- New concerns plug in as new fibers without touching existing ones
- Maps cleanly to Convex's `Promise.allSettled` pattern — each fiber is an async operation within the pulse action
- The pulse is the heartbeat; fibers are the nervous system within it

**Future fibers (v2+):**
- Ensemble maintenance fiber (cluster/merge/split)
- Contradiction detection fiber
- Resonance scanning fiber
- Self-reflection fiber (v6 — lattice introspection)

### The Crystalline Lattice (Endgame Architecture)

The full architecture is a distributed cognition system over the memory graph:

**Layer 1 -- Memory Nodes (lattice points)**
Each memory cluster (5-50 memories) gets its own lightweight model instance. It knows only its local neighborhood: the memories, their relationships, their temporal patterns, their contradiction state. No single node sees the whole graph.

**Layer 2 -- Orchestrator Layer (lattice bonds)**
Orchestrator models sit between clusters and handle:
- Routing queries to relevant neighborhoods
- Aggregating responses from multiple nodes
- Detecting resonance (aligned signals from distant nodes)
- Detecting contradiction (conflicting signals)
- Forming speculative bundles from cross-node patterns

**Layer 3 -- Synthesis Layer (crystal face)**
A single high-capability model receives pre-assembled, pre-evaluated results and produces the final output. Needs minimal context because the lattice pre-chewed everything.

### Model Selection

**v1 Pulse Models (shipped — 6 user-configurable presets via OpenRouter):**

| Preset | Model | Provider | Cost/pulse (est.) |
|--------|-------|----------|-------------------|
| Potato | GPT-5 Nano | OpenAI | Lowest |
| Low | Gemini 2.0 Flash-Lite | Google | Low |
| Medium | Gemini 2.5 Flash | Google | Medium |
| High | GPT-4.1 Mini | OpenAI | Medium-High |
| Ultra | Gemini 3.1 Pro | Google | High |
| Sonnet | Claude Sonnet 4.6 | Anthropic | High |

All calls routed through OpenRouter for unified cost tracking. Per-user model stored in `organicTickState.organicModel`.

**Endgame Lattice Models (planned):**

| Role | Model | Cost/activation |
|------|-------|-----------------|
| Node (v3+) | Gemini Flash Lite / Haiku / Spark / self-hosted 1.5B-3B | $0.001-0.01 |
| Orchestrator (v3+) | Gemini 2.5 Flash / Sonnet | $0.05-0.20 |
| Synthesis (v4+) | Opus / GPT-5.4 | $0.10-0.50 |

### Scaling Properties
- No single model needs large context (50 memories per node max)
- More memories = more nodes, not bigger context (horizontal)
- More nodes = more intelligence (emergent cross-node patterns)
- Embarrassingly parallel (node activations are independent)
- The graph IS the intelligence -- not any single model

---

## 3. Schema: Prospective Traces

Added directly to MC's Convex schema. A prospective trace is a forward-looking memory object.

### Fields

```
prospectiveTrace {
  // Identity
  id: Id<"prospectiveTraces">
  userId: Id<"users">
  createdAt: number          // timestamp of creation
  tickId: string             // which tick generated this trace
  
  // Prediction
  predictedQuery: string     // what the user is likely to ask/need
  predictedContext: string   // pre-assembled context bundle for that query
  traceType: "query" | "context" | "contradiction" | "action" | "resonance"
  
  // Confidence & Lifecycle
  confidence: number         // 0.0-1.0, how sure are we this will be needed
  expiresAt: number          // TTL -- when this trace auto-expires if unvalidated
  validated: boolean | null  // null = pending, true = used, false = expired unused
  validatedAt?: number       // when it was confirmed or expired
  
  // Sourcing
  sourceMemoryIds: Id<"memories">[]  // which memories contributed to this prediction
  sourcePattern: string      // human-readable description of why this was predicted
  
  // Scoring (updated over time)
  accessCount: number        // how many times this trace was served to a query
  usefulness: number         // 0.0-1.0, user/system rating of whether it helped
  
  // Lattice metadata (v3+)
  nodeId?: string            // which lattice node generated this
  orchestratorId?: string    // which orchestrator aggregated this
  resonanceCluster?: string  // if part of a resonance pattern
}
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
Created (tick) → Pending → Served (matched to a query) → Validated/Expired
                    ↓
                  TTL expires → Expired (unvalidated)
```

### MC Schema Changes Required

1. New table: `prospectiveTraces` (schema above)
2. New store type in memories: `"prospective"` (already exists in MC)
3. New field on existing memories: `lastAccessedAt` (timestamp), `accessCount` (number)
4. New index on memories: `by_updated` for efficient "what changed since last tick" queries
5. New webhook/event system: emit events on memory store, recall, expire

---

## 4. Ideas (Eureka Discovery)

### What Are Ideas?

Ideas are cross-memory connections the engine discovers during pulses — genuinely novel insights the user hasn't seen. While traces predict what the user will *ask*, ideas reveal what the user *doesn't know they should know*.

Ideas are NOT trace predictions rebranded. They are higher-order: they synthesize across multiple memories, ensembles, and domains to produce actionable insights. A trace says "you'll probably ask about the deployment timeline." An idea says "your deployment timeline conflicts with the hiring freeze you discussed last week, and three past projects with this pattern shipped 2-3 weeks late."

### Idea Types

| Type | What It Discovers | Example |
|------|------------------|---------|
| cross-domain | Connections between unrelated memory clusters | "Your notes on mycelial networks from biology reading share structural parallels with the distributed cache architecture you're designing" |
| pattern | Recurring theme the user hasn't named | "You've mentioned 'technical debt' in 4 separate project contexts this month — always right before a deadline" |
| contradiction-resolution | A way to resolve conflicting memories | "Budget discrepancy between Q1 plan ($50K) and team lead's email ($75K) — the Q2 revision memo from March 3 explains the delta" |
| opportunity | Actionable insight from combining facts | "Client A's request for real-time analytics + your team's unused Kafka expertise = potential upsell" |

### Schema: `organicIdeas`

```
organicIdeas {
  id: Id<"organicIdeas">
  userId: Id<"users">
  createdAt: number
  pulseId: string                    // which pulse generated this idea
  
  // Content
  title: string                      // short headline: "Deployment timeline conflicts with hiring freeze"
  summary: string                    // 2-3 sentence explanation with evidence
  ideaType: "cross_domain" | "pattern" | "contradiction_resolution" | "opportunity"
  
  // Sourcing
  sourceMemoryIds: Id<"crystalMemories">[]  // memories that contributed
  confidence: number                 // 0.0-1.0
  
  // Lifecycle
  status: "pending_notification" | "notified" | "read" | "dismissed" | "starred"
  notifiedAt?: number
  readAt?: number
  dismissedAt?: number
  starredAt?: number
  
  // Delivery tracking
  deliveryMethod?: "injection" | "email" | "dashboard"
  deliveryAttempts: number           // how many times delivery was attempted
}
```

### Lifecycle

```
Discovered (pulse fiber) → pending_notification
  → Injected in next turn (notified) → User reads (read) → starred / dismissed
  → OR email digest sent (notified) → User reads (read) → starred / dismissed
  → OR viewed on dashboard (read) → starred / dismissed
```

### Discovery Fiber

The connection discovery fiber runs within each pulse:

1. Sample N recent memories (biased toward high-strength, recently accessed)
2. For each, retrieve semantically distant but thematically adjacent memories (cosine 0.3-0.6 range — close enough to relate, far enough to surprise)
3. Ask the pulse model: "Given these memories from different contexts, is there a non-obvious connection, pattern, or actionable insight?"
4. Filter: discard anything that's just a summary of known facts (the model must identify something the user hasn't explicitly stated)
5. Deduplicate against existing ideas (embedding similarity check)
6. Write surviving ideas to `organicIdeas` with `status: pending_notification`

**Quality gate:** Ideas must clear a confidence threshold (configurable, default 0.7) and must reference at least 2 memories from different time periods or domains.

---

## 5. Notification Delivery Pipeline

### The Problem

Ideas are worthless if the user never sees them. The engine runs between turns — there's no guarantee the user is present when an idea is discovered. The notification pipeline ensures ideas reach the user regardless of when they next interact.

### Two-Tier Delivery

**Tier 1: Next-Turn Injection**
The plugin recall hook (`before_agent_start`) checks for pending ideas before each AI turn:

```
// In recall-hook.js (before_agent_start)
const pendingIdeas = await fetchPendingIdeas(userId, { limit: 3 });
if (pendingIdeas.length > 0) {
  injectIntoSystemPrompt(`
    While you were away, your memory discovered:
    ${pendingIdeas.map(i => `• ${i.title}: ${i.summary}`).join('\n')}
    
    These are insights from your Memory Crystal's background processing.
    Mention them naturally if relevant to the conversation.
  `);
  await markNotified(pendingIdeas.map(i => i.id), "injection");
}
```

This works across ALL clients — Claude Code, Codex, OpenClaw, Factory, any MCP client — because delivery happens in the plugin/recall layer, not in any specific client UI.

**Tier 2: Email Digest Fallback**
If no turn happens within N hours (configurable, default 6h), a Convex scheduled job sends an email digest:

```
// Convex cron: checkIdeaDelivery runs every hour
const staleIdeas = await getIdeasOlderThan(userId, hoursThreshold);
if (staleIdeas.length > 0 && userHasEmailNotifications(userId)) {
  await sendIdeaDigestEmail(userId, staleIdeas);
  await markNotified(staleIdeas.map(i => i.id), "email");
}
```

### Dashboard Settings

Users control notification behavior from the Organic Settings sub-page:

| Setting | Options | Default |
|---------|---------|---------|
| Email notifications | On / Off | Off |
| Idea frequency | Aggressive / Balanced / Conservative | Balanced |
| Email digest delay | 2h / 6h / 12h / 24h | 6h |
| Max ideas per turn | 1 / 3 / 5 | 3 |

**Frequency modes:**
- **Aggressive:** Discovery fiber runs every pulse, low confidence threshold (0.5), surfaces more ideas
- **Balanced:** Discovery fiber runs every 5th pulse, medium threshold (0.7), quality over quantity
- **Conservative:** Discovery fiber runs every 20th pulse, high threshold (0.85), only high-confidence insights

---

## 6. Version Roadmap

### v1.0 — The Pulse Engine ✅ SHIPPED (March 28-29, 2026)

**Goal:** Single anticipation agent runs on a pulse (tick), reads MC activity, writes prospective traces. Proof of concept.

**Status:** Shipped in 2 days. Option A (Convex scheduled function) was chosen as recommended.

**What shipped:**
- Self-scheduling pulse engine via `scheduler.runAfter()` — `processUserTick` self-schedules after completion (not cron-driven; cron is heartbeat/recovery only)
- Sub-second interval tiers: Live (0ms), 1s, 3s, 5s, 10s, 20s, 30s, 1m through 60m
- 6 configurable model presets per user: Potato (GPT-5 Nano), Low (Gemini 2.0 Flash-Lite), Medium (Gemini 2.5 Flash), High (GPT-4.1 Mini), Ultra (Gemini 3.1 Pro), Sonnet (Claude Sonnet 4.6)
- Multi-provider HTTP callers (Gemini + OpenAI + Anthropic), all routed through OpenRouter for unified cost tracking
- Per-user model selection stored in `organicTickState.organicModel`
- Prospective traces table with full lifecycle: created → pending → served → validated/expired
- Trace types: query, context, contradiction, action, resonance
- Activity logging via `activityLog` table (memory_archived, memory_created, pulse events)
- Dashboard: model selection cards with pricing, pulse interval controls, trace viewer with expandable rows, spend telemetry
- Dynamic lease scaling
- Full implementation: `convex/crystal/organic/tick.ts` (886 lines), `convex/crystal/organic/models.ts`

**Knowledge Bases (not in original PRD — added during v1.0):**
- First-class MC entity: `knowledgeBases` table with full CRUD
- Optional `knowledgeBaseId` on `crystalMemories` for KB association
- Enrichable but NOT decayable — KBs are persistent reference material
- Pulse engine includes KB context in anticipation
- Dashboard management UI + standalone Knowledge Bases page with nav entry

**Recall Intelligence (shipped as v0.6.4 — not in original PRD):**
- Recall confidence scoring with 7 ranking signals: vector similarity, strength, freshness, salience, text match, continuity, access frequency
- Confidence labels: `[HIGH CONFIDENCE]` >= 0.85, `[low confidence]` < 0.5
- Mandatory recall acknowledgment directive for high-confidence memories
- Intent-triggered deep recall: question/recall → 8 results, reflect → 6, command → 5, general → 3
- Available in both plugin (v0.6.4) and MCP server (v0.3.1)

**crystal_forget (not in original PRD):**
- Archive or permanently delete memories via tool call
- Supports both soft archive and permanent deletion
- Ownership verification and rate limiting

**What it proved:**
- Anticipation is viable. Traces are being generated and served.
- Self-scheduling via `scheduler.runAfter()` is more reliable than cron for sub-minute intervals.
- OpenRouter provides clean cost tracking across all providers.
- Sub-second intervals (Live, 1s, 3s) are achievable in the Convex runtime.

**Implementation notes (what differed from the original plan):**
- "Tick" renamed to "Pulse" for external branding (tick = internal terminology, pulse = user-facing)
- Model selection expanded from "Gemini 2.5 Flash / Sonnet 4.5" to 6 presets across 3 providers
- All inference routed through OpenRouter (not direct API calls) for unified billing
- Interval range far exceeded the original 1/hour and 1/min spec — shipped with sub-second options
- Knowledge Bases emerged as a necessary first-class entity during implementation
- Recall Intelligence added to close the loop on trace serving quality

**Technical implementation (actual):**
```
// Self-scheduling pulse engine (simplified from tick.ts)
processUserTick = internalAction(async (ctx, { userId }) => {
  // 1. Acquire lease (dynamic scaling)
  const lease = await acquireLease(ctx, userId);

  // 2. Get recent activity from activityLog
  const recentActivity = await ctx.runQuery(getRecentActivity, { userId, since: lastPulseTime });

  // 3. Build pulse context (memories + KB context + traces)
  const pulseContext = buildPulseContext(recentActivity, knowledgeBases);

  // 4. Call anticipation model via OpenRouter
  const model = getUserModel(userId); // One of 6 presets
  const predictions = await callOpenRouter(model, pulseContext);

  // 5. Write prospective traces
  for (const prediction of predictions) {
    await ctx.runMutation(writeTrace, { ...prediction, userId });
  }

  // 6. Expire stale traces
  await ctx.runMutation(expireTraces, { userId });

  // 7. Self-schedule next pulse
  const interval = getUserInterval(userId); // Live through 60m
  await ctx.scheduler.runAfter(interval, processUserTick, { userId });
});
```

### v1.1 — Fibers, Ideas, Trace v2 & Notifications 🔧 IN PROGRESS (March 30-31, 2026)

**Goal:** The pulse engine grows fibers for parallel processing, discovers cross-memory ideas, fixes trace prediction from 0% to viable hit rates, and delivers insights to users across all clients.

**Scope expanded significantly from original plan.** Original v1.1 was trace serving + conversation-reactive pulse. Now includes fibers architecture, ideas discovery, notification pipeline, trace prediction v2, and dashboard sub-navigation.

**What ships:**

**Fibers Architecture:**
- Pulse refactored from sequential steps to parallel fibers (see Section 2)
- Each fiber runs independently within a single pulse cycle via `Promise.allSettled`
- v1.1 ships with 4 fibers: trace prediction, connection discovery, procedural extraction, content security

**Ideas (Eureka Discovery):**
- New `organicIdeas` table (see Section 4)
- Connection discovery fiber generates cross-memory insights each pulse
- Quality gate: confidence >= 0.7, minimum 2 source memories from different domains/time periods
- Deduplication against existing ideas via embedding similarity

**Notification Delivery Pipeline:**
- Tier 1: Next-turn injection via `before_agent_start` hook (works across all clients)
- Tier 2: Email digest fallback after configurable delay (default 6h)
- Dashboard settings: email toggle, frequency mode (aggressive/balanced/conservative), digest delay
- See Section 5 for full specification

**Trace Prediction v2 (The Big Fix):**

Current state: 0% hit rate (0/7,295 traces validated). Research identified why and how to fix it.

*Research basis:*
- **Salesforce VoiceAgentRAG:** 75% cache hit rate using document-style descriptions (not questions), document embeddings (not query embeddings), low cosine threshold (0.40)
- **Nemori paper:** Predict-Calibrate Principle — only predict for blind spots, not everything
- **Hindsight (Vectorize.io):** 83.6-91.4% accuracy via structured memory (4 networks)

*5 concrete fixes:*
1. **Query-to-document embeddings:** Switch from embedding predicted queries to embedding document-style descriptions of what the trace covers. Match incoming queries against document embeddings with cosine threshold 0.40 (not 0.85). This is the single biggest fix — v1 was matching query embeddings against query embeddings, which almost never works.
2. **Recall query log:** New table tracking every actual recall query. This is the training signal — know what users actually ask so predictions can target real patterns instead of guessing.
3. **Predict-calibrate:** Before generating traces, check existing recall coverage. Only predict for blind spots — topics the user has memories about but no recent recall activity for. Stop predicting things the user already has good coverage on.
4. **Warm cache:** Conversation pulse pre-fetches top 10 related memory chunks into a fast-access cache. Not prediction — preparation. If the user is discussing topic X, have topic X's full context ready.
5. **Fewer, sharper predictions:** 3 high-quality traces per pulse instead of 10 garbage ones. Better model + better prompt + predict-calibrate filtering = dramatically higher precision.

**Conversation-Reactive Pulse:** Pulse fires based on conversation content, not just timer. Seeded with recent messages for focused anticipation.

**Procedural Memory Auto-Extraction:** Fiber detects workflow patterns in conversation history and auto-creates procedural memories with deduplication.

**Memory Content Security Scanning:** Fiber runs injection/exfiltration detection on the write path. Pattern-based scanner for prompt injection, role hijacking, and exfiltration attempts.

**Dashboard Sub-Navigation:**
The Organic page splits into sub-routes with expandable sidebar navigation:
- **Overview** — health metrics, pulse status, quick stats
- **Ideas** — eureka discoveries, starred/dismissed/read, idea feed
- **Traces** — predictions, hit rate, validation timeline
- **Ensembles** — clusters, motifs, conflicts (placeholder for v2)
- **Settings** — model selection, pulse interval, notification prefs, budget

Currently one 903-line `page.tsx`. Refactors into `organic/overview/`, `organic/ideas/`, `organic/traces/`, `organic/ensembles/`, `organic/settings/` sub-routes.

**Success criteria:**
- Trace hit rate: >10% within first week of v2 fixes (up from 0%)
- Trace hit rate: >25% after 2 weeks with recall query log training data
- Recall latency with trace check: <50ms overhead
- Ideas: >50% of surfaced ideas rated "interesting" or "useful" by user
- Ideas: <20% dismissed without reading
- Notification delivery: 100% of pending ideas delivered within 1 turn or email delay window
- Conversation-reactive pulses fire within 1 pulse of relevant activity
- Security scanner catches >90% of known injection patterns with <5% false positive rate

### v2.0 — Memory Ensembles (Weeks 7-12)

**Goal:** Move from individual memories to memory structures. The foundation for resonance and contradiction detection.

**What ships:**
- Cluster detection: group related memories into ensembles (semantic, temporal, causal)
- Ensemble types:
  - **Clusters** -- semantically related memories forming a topic
  - **Motifs** -- recurring patterns across time
  - **Conflict groups** -- memories that contradict each other
  - **Trajectories** -- sequences showing evolution of a topic/decision
  - **Project arcs** -- memories tied to a specific project/goal
  - **Unresolved threads** -- open loops (questions asked but not answered, actions mentioned but not confirmed)
- Enhanced tick: anticipation model reasons over ensembles, not just individual memories
- Ensemble metadata stored in MC (new table or enrichment on existing memory relationships)

**Technical approach:**
- Initial clustering: embedding-based (group memories with cosine similarity >0.85)
- Refinement: tick agent reclassifies clusters each pass, splitting/merging as needed
- Conflict detection: pairs of memories in same cluster with contradictory claims (detected by model)
- Trajectory detection: temporal ordering within a cluster, looking for evolution patterns

**Success criteria:**
- Ensemble recall: when a query matches a cluster, return the whole cluster (not just top-k individual memories)
- Contradiction surfacing: detect >80% of known contradictions in test set
- Motif detection: identify recurring themes across 30+ day windows

### v2.1 — Contradiction & Resonance Engine (Weeks 13-16)

**Goal:** The system actively finds and surfaces problems and patterns the user hasn't asked about.

**What ships:**
- Contradiction scanner: each tick checks recent memories against existing ensembles for conflicts
- Contradiction trace type: auto-generated trace when conflict detected, with both memories cited
- Resonance scanner: each tick looks for weak reinforcing signals across distant ensembles
- Resonance trace type: "three separate conversations over 2 weeks all suggest X"
- Proactive alerts: if confidence on a contradiction or resonance trace exceeds threshold, flag it for the user (via MC's existing notification hooks)
- Resolution tracking: when user acknowledges/resolves a contradiction, update both memories

**Success criteria:**
- Contradiction detection precision >85%
- Resonance patterns surfaced that humans rate as "genuinely useful insight" >50% of the time
- False alarm rate <20%

### v3.0 — The Lattice (Weeks 17-28)

**Goal:** Replace the single tick agent with distributed node models. The crystalline lattice comes alive.

**What ships:**
- Node model layer: each memory cluster gets its own small model instance (1.5B-3B)
- Node assignment: automated cluster → node mapping based on memory count and topic density
- Node inference: each tick, activated nodes process their local neighborhood and emit signals
- Orchestrator layer: routes tick signals, aggregates node outputs, detects cross-node patterns
- Inter-node communication protocol: nodes share summaries with neighbors, not raw memories
- Dynamic node scaling: as memory count grows, new nodes spin up; as clusters shrink, nodes merge
- Tick parallelism: nodes fire in parallel within each tick (embarrassingly parallel)

**Model selection for nodes:**
- Cloud: Gemini Flash Lite, Haiku 4.5, Spark ($0.001-0.01 per activation)
- Self-hosted: Qwen 2.5 1.5B Q4, Gemma 3 2B Q4, Phi-3.5 mini Q4 (via MLX or llama.cpp)

**Orchestrator implementation:**
- Single orchestrator model per tick (Gemini 2.5 Flash / Sonnet)
- Receives: all node signals from the current tick
- Produces: aggregated insights, resonance detections, contradiction flags, prospective trace candidates
- Routes: queries to the 5-15 most relevant nodes (replaces embedding-based retrieval)

**Where it runs:**
- Cloud: parallel API calls to Flash-tier models (simple, scalable)
- Self-hosted: multiple small models on Mac Studio (192-512GB) or GPU server
- Hybrid: nodes self-hosted, orchestrator + synthesis via API

**Success criteria:**
- Lattice recall quality > single-agent recall quality (A/B test)
- Cost per query with lattice < cost of single Opus call with equivalent context
- Node activation time <500ms (API) or <2s (self-hosted)
- Graceful degradation: if some nodes fail, recall still works (just lower quality)

### v3.1 — 1 Tick/Second (Weeks 29-32)

**Goal:** Enterprise-grade tick rate. The memory system thinks continuously.

**What ships:**
- Optimized tick pipeline: <1s total for node activation → orchestrator → trace write
- Batched node activation: fire all nodes simultaneously, aggregate with timeout
- Streaming orchestrator: start aggregating as node responses arrive, don't wait for all
- Delta processing: nodes only process changes since last tick, not their full neighborhood
- KV cache warming: keep node model contexts warm between ticks (reduces inference time)
- Tick budget enforcement: if a tick exceeds its time window, skip low-priority nodes

**Technical requirements:**
- Node inference: <100ms (requires self-hosted or Groq-tier API speed)
- Orchestrator inference: <200ms
- Trace write: <50ms
- Total: <500ms leaves 500ms headroom per tick

**Success criteria:**
- Sustained 1 tick/sec for 24 hours without drift or accumulating latency
- Memory consumption stable (no leaks from warm KV caches)
- Trace quality at 1/sec >= trace quality at 1/min (faster isn't worse)

### v4.0 — Synthesis Layer & Prepared Thought Surfaces (Weeks 33-40)

**Goal:** The full three-layer lattice. Queries are answered by the lattice, not by searching memory.

**What ships:**
- Synthesis model integration: top-tier model (Opus / GPT-5.4) receives lattice output
- Prepared thought surfaces: pre-assembled context packages ready to serve before the query arrives
- Query pipeline rewrite: query → orchestrator routes to nodes → nodes respond → orchestrator aggregates → synthesis produces answer
- Bypass mode: for simple queries, skip synthesis and serve directly from orchestrator output
- Context compression: lattice output is compressed to <2K tokens regardless of total memory count
- Quality metrics: automated evaluation of synthesis output vs. direct retrieval output

**What this changes for the user:**
- Recall responses include anticipatory context (things they didn't ask for but will need)
- Contradictions are pre-resolved or flagged in the response
- Response quality scales with memory count (more memories = smarter lattice, not slower retrieval)

**Success criteria:**
- Synthesis output rated higher than direct retrieval by human evaluators in >70% of cases
- Latency from query to synthesis output: <3 seconds (cloud), <10 seconds (self-hosted)
- Context compression: lattice handles 100K+ memories but synthesis model receives <2K tokens

### v5.0 — Adaptive Topology & Self-Organization (Endgame)

**Goal:** The lattice restructures itself. This is where current technology runs out.

**What would ship (when technology allows):**
- Self-organizing nodes: lattice automatically creates, merges, splits, and kills nodes based on usage patterns
- Adaptive model selection: nodes upgrade/downgrade their model based on cluster complexity
- Emergent specialization: some nodes develop expertise in certain topic domains
- Cross-user lattice learning: patterns discovered in one user's lattice inform cold-start for new users (privacy-preserving, no raw memory sharing)
- Persistent model state: nodes maintain internal state between ticks (no cold start)
- Sub-millisecond inference: node activation in <10ms for true real-time cognition
- Autonomous goal tracking: lattice detects open goals in memory and proactively works toward them

**Technology dependencies (what needs to be invented):**

| Technology | Status (March 2026) | Needed For | ETA |
|-----------|-------------------|-----------|-----|
| Sub-millisecond model inference | Groq at ~40ms, need <10ms | 1 tick/sec at 1000+ nodes | 2028-2030 |
| Persistent model state | Google context caching is early | No cold start between ticks | 2027-2029 |
| Self-organizing model topology | Academic research only | Adaptive lattice structure | 2030+ |
| Sub-cent inference at scale | Costs dropping ~10x/year | Economic viability at 1/sec | 2026-2027 |
| Model-to-model direct communication | HPC only (NVLink, InfiniBand) | Lattice inter-node signaling | 2027-2028 |
| Efficient contradiction detection | KG research, O(n^2) problem | Scale past 100K memories | 2027-2028 |

**The honest timeline:** v5 endgame components land between 2028-2031 as infrastructure catches up. The architecture is designed now so these breakthroughs slot in without rewrites.

### v6.0 — Self-Improving Architecture & The Invention Loop (2030+)

**Goal:** The lattice reasons about its own performance, proposes optimizations, and generates novel technical insights that exceed human cross-domain reach. This is where the system transitions from tool to collaborator.

**The feedback loop:**
```
Better software (lattice optimization)
  → Discovers patterns humans miss (cross-domain resonance)
  → Those patterns improve hardware/architecture design
  → Better hardware runs bigger/faster lattice
  → Bigger lattice discovers more patterns
  → Repeat
```

**What ships (as technology allows):**

**Self-Reflection Memories**
The lattice stores its own performance data as first-class memories -- tick latency distributions, cache miss rates, node activation patterns, which nodes fire together, which predictions hit, which miss and why. These aren't logs. They're memories the lattice reasons about, the same way it reasons about user memories.

The contradiction engine runs over self-reflection memories too. "Node activation latency averaged 12ms last week but 47ms this week. Nothing changed in the config." That's an anomaly. The lattice investigates it the same way it investigates contradictions in user data -- except now the subject is itself.

**Hypothesis Traces**
New trace type beyond query/context/contradiction/resonance: `hypothesis`. A hypothesis trace proposes a novel technical idea and tracks its evaluation.

```
hypothesisTrace {
  hypothesis: string        // "Sparse attention pattern X from domain A 
                            //  could reduce orchestrator aggregation from 
                            //  O(n) to O(sqrt(n))"
  domain_sources: string[]  // ["memory-architecture", "sparse-linear-algebra", 
                            //  "lattice-performance-metrics"]
  source_nodes: string[]    // which nodes contributed the cross-domain insight
  evidence_for: string[]    // supporting observations
  evidence_against: string[] // contradicting observations
  testable: boolean         // can this be evaluated automatically?
  test_plan?: string        // if testable, how to evaluate
  evaluation_result?: string // what happened when tested
  status: "proposed" | "testing" | "validated" | "rejected" | "incorporated"
}
```

**Evaluation Loop**
When a hypothesis trace is generated and marked `testable: true`, the system can spawn a lightweight evaluation:
- Code hypotheses: generate code, run benchmarks, compare results
- Architecture hypotheses: simulate with smaller lattice, measure impact
- Mathematical hypotheses: formal verification or proof sketching
- Hardware hypotheses: estimate feasibility against known physics/manufacturing constraints

Results feed back as new memories, informing the next hypothesis cycle.

**Hardware Description Language**
A structured way for the system to describe proposed hardware modifications. Not vague suggestions -- specific, evaluable proposals:

```
hardwareProposal {
  component: "memory_controller" | "compute_unit" | "interconnect" | "cache" | ...
  current_behavior: string    // "KV cache evicted on context switch, 40ms cold start"
  proposed_change: string     // "Persistent memory segment survives context switches"
  expected_impact: string     // "Node reactivation drops from 40ms to 0.3ms"
  confidence: number          // how sure the lattice is this would work
  constraints: string[]       // physical/manufacturing constraints considered
  derived_from: string[]      // which hypothesis traces led here
}
```

These proposals are surfaced to human engineers for evaluation. The lattice doesn't build hardware -- it identifies what hardware SHOULD exist based on its deep understanding of its own bottlenecks crossed with its knowledge of materials science, chip design, and manufacturing.

**The five stages of the invention loop:**

| Stage | When | What the Lattice Does | Invention Level |
|-------|------|----------------------|-----------------|
| 1 | v2-v3 (2026-2027) | Finds patterns in user memories humans would miss | Discovery (pattern recognition) |
| 2 | v3-v4 (2027-2028) | Combines ideas across domains no single human bridges | Novel recombination |
| 3 | v4-v5 (2028-2029) | Generates and tests hypotheses about its own architecture | Self-optimization |
| 4 | v5-v6 (2029-2030) | Proposes hardware changes based on self-diagnosed bottlenecks | **Loop opens** |
| 5 | v6+ (2030-2031) | Generates hardware designs, software optimizations, and architectural innovations that feed back into its own capability | **Loop closes** |

**Why this architecture specifically enables invention (and most AI systems don't):**

1. **Distributed expertise.** Each node is a deep specialist in its local memory neighborhood. A single large model is a generalist. Invention comes from deep knowledge in multiple domains colliding -- which is what the orchestrator does when it aggregates signals from specialist nodes.

2. **Persistent cross-domain memory.** The lattice doesn't just process information -- it remembers every insight, every failed hypothesis, every surprising connection. Over months and years, this accumulates into a knowledge base that no single research session could produce.

3. **Anomaly detection is built in.** The contradiction engine already looks for things that don't fit. Anomalies are the raw material of discovery. Most AI systems optimize for consistency. This one is specifically designed to find inconsistencies.

4. **Self-reflection is structural.** Because the lattice's own performance data is stored as memories in the same graph, the same reasoning machinery that finds patterns in user data finds patterns in its own behavior. It doesn't need a separate introspection module -- introspection is just another domain the lattice has nodes for.

5. **The hypothesis-evaluation-memory cycle mirrors the scientific method.** Observe (resonance detection) -> Hypothesize (hypothesis traces) -> Test (evaluation loop) -> Record (memories) -> Repeat. This isn't bolted on -- it's the natural extension of the prospective trace system.

**What could the loop actually produce?**

Concrete examples of inventions a mature lattice might generate:

- A novel memory addressing scheme that reduces cache misses by 60%, discovered by cross-referencing database indexing strategies with neuroscience memory consolidation patterns
- An inference chip architecture optimized for many-small-model workloads (not the single-large-model workloads GPUs are designed for), derived from analyzing its own activation patterns
- A new inter-node communication protocol inspired by mycelial nutrient signaling networks, reducing orchestrator bandwidth by 10x
- A sparse attention variant discovered by noticing structural similarities between its own node activation graphs and error-correcting codes

Each of these becomes a memory, informing the next cycle. The loop compounds.

**Prerequisites (what must exist before v6 is possible):**
- v5 self-organizing topology (lattice must be stable enough to reason about itself)
- 100K+ memories minimum (enough cross-domain surface area for non-trivial recombination)
- 1,000+ active nodes (enough specialist diversity for real cross-domain reach)
- Evaluation infrastructure (sandboxed code execution, benchmarking pipelines)
- Human review layer (lattice proposals must be evaluated by engineers before implementation)

**The human role doesn't disappear -- it shifts.** Humans stop directing research and start evaluating proposals. The lattice generates 100 hypotheses. Engineers evaluate the 5 most promising. The lattice learns from which ones engineers approve and reject. The selection function is human judgment. The generation function is the lattice.

---

## 7. MC Foundation Work (Ship Now)

These changes go into Memory Crystal's codebase today. They're useful on their own and required for Organic Memory.

### 5a. Activity Events

MC emits events when memories are stored, recalled, or expired. Organic Memory subscribes.

**Implementation:** Internal Convex function hooks (not external webhooks for v1).

```
// On memory store
afterMemoryStore(ctx, memory) → emit({ type: "memory_stored", memoryId, timestamp, store, category })

// On recall
afterRecall(ctx, query, results) → emit({ type: "recall_triggered", query, resultCount, timestamp })

// On expire/archive
afterMemoryExpire(ctx, memoryId) → emit({ type: "memory_expired", memoryId, timestamp })
```

Events written to a new `activityLog` table. Organic Memory reads this table each tick.

### 5b. Prospective Trace Schema

New table in Convex schema (see Section 3 for full schema).

### 5c. Memory Access Metadata

Add to existing memories table:
- `lastAccessedAt: v.optional(v.number())` -- updated on every recall that returns this memory
- `accessCount: v.optional(v.number())` -- incremented on every access
- `updatedAt: v.number()` -- indexed, for efficient "what changed" queries

### 5d. Recall Pipeline Hook

Modify MC's recall path to check prospective traces before (or alongside) normal search:

```
recall(query) {
  // Check prospective traces (fast indexed lookup)
  const traces = await matchProspectiveTraces(query);
  
  // Normal recall
  const memories = await normalRecall(query);
  
  // Merge: traces first if high confidence, then memories
  return mergeResults(traces, memories);
}
```

---

## 8. Hardware & Deployment

### v1-v2: Cloud Only
- Runs inside MC's Convex backend as scheduled functions
- No additional infrastructure needed
- Inference via API (Gemini Flash, Sonnet, etc.)
- Cost: tick frequency * cost per tick

### v3: Cloud or Self-Hosted Nodes

**Cloud deployment:**
- Node activations: parallel API calls to Flash-tier models
- Orchestrator: single API call per tick
- Scale: add more parallel API calls as memory count grows

**Self-hosted deployment (Mac Studio):**

| Config | Memory | GPU Cores | Node Capacity | Max Tick Rate | Price |
|--------|--------|-----------|--------------|---------------|-------|
| M3 Ultra 192GB | 192GB (~150GB usable) | 80 | ~160 nodes (1.5B Q4) | 1/min | ~$6,000 |
| M3 Ultra 512GB | 512GB (~400GB usable) | 80 | ~440 nodes (1.5B Q4) | 1/min | ~$10,000 |
| M4 Ultra (future) | TBD | TBD | More | Faster | TBD |

**Self-hosted inference speeds (estimated, 1.5B Q4 via MLX):**
- Single node: ~150-200 tok/sec → full response in ~1-2s
- 16 nodes parallel (GPU sharing): ~30-50 tok/sec each → full response in ~4-7s each
- 100 nodes in 7 batches of ~16: ~30-50 seconds total per tick
- Achievable: 1 tick/min comfortably, 1 tick/30sec with optimization

**GPU server deployment (for scale):**

| Config | Nodes (concurrent) | Cost/mo | Tick Rate |
|--------|-------------------|---------|-----------|
| 1x A10G (24GB VRAM) | ~12 (1.5B Q4) | ~$300/mo | 1/min |
| 4x T4 (64GB total VRAM) | ~32 | ~$600/mo | 1/30sec |
| 1x A100 (80GB VRAM) | ~40 | ~$1,200/mo | 1/15sec |
| 8x A100 (640GB VRAM) | ~300+ | ~$10,000/mo | 1/sec |

### Node Tiering Architecture (The 100x Multiplier)

The naive approach loads every node model into RAM simultaneously. This caps a 192GB Mac Studio at ~160 nodes / 8,000 memories. With tiered node management, the same hardware handles 750K+ memories.

**Tier 1: Hot Nodes (loaded model, instant activation)**
- 25-30 most active clusters stay as loaded 1.5B Q4 models in RAM
- ~25GB total. Covers daily-use memories.
- Activation: <50ms (model already warm)

**Tier 2: Warm Nodes (semantic signature, fast swap)**
- 200-500 clusters represented by compressed semantic signatures: a small embedding + summary vector generated during last active session
- ~2KB per node. 500 warm nodes = ~1MB. Essentially free.
- When a query matches a warm node's signature, promote to hot (load model, ~1-2s on MLX)
- Background ticks scan warm nodes periodically to keep signatures fresh

**Tier 3: Cold Nodes (index only, background discovery)**
- Everything else. Thousands to hundreds of thousands of clusters stored as plain embeddings in a vector index.
- No model, no summary -- just enough to know "this cluster exists and is about X"
- Background ticks scan cold nodes. When relevance is detected, promote to warm (generate signature) or hot (load model).
- Each cold node: ~768 bytes (embedding). 100K cold nodes = ~75MB.

**Semantic Router**
A single small model (1.5B Q4, ~0.9GB) stays permanently loaded as the traffic controller. It reads the query, reads cluster summaries, and decides which hot nodes to activate and which warm/cold nodes to promote. Smarter than cosine similarity, cheaper than loading every node.

**192GB Mac Studio with tiering:**

| Tier | Nodes | Memories | RAM |
|------|-------|----------|-----|
| Hot (loaded models) | 25 | 1,250 | ~25GB |
| Warm (semantic signatures) | 500 | 25,000 | ~1MB |
| Cold (embedding index) | 15,000+ | 750,000+ | ~500MB |
| Semantic Router | 1 model | -- | ~0.9GB |
| Orchestrator | 1 model (7B) | -- | ~4GB |
| **Total** | **15,526+** | **776,000+** | **~30GB** |

Leaves ~120GB for OS, swap buffer for hot/warm promotion, and headroom.

**Promotion/demotion policy:**
- Access frequency drives promotion (cold -> warm -> hot)
- Time decay drives demotion (hot -> warm -> cold)
- Background ticks handle all promotions/demotions (never on the query path)
- Emergency promotion: if a live query matches a warm node, promote synchronously (1-2s penalty)

### Scaling to Billions: The Long-Term Hardware Path

The tiering architecture means memory capacity is limited by index storage, not model RAM. This opens a path to billions of memories.

**The math for 1 billion memories:**

At 50 memories per cluster = 20 million clusters. Most are cold.

| Tier | Nodes | Memories | Storage |
|------|-------|----------|---------|
| Hot | 50-100 | 2,500-5,000 | ~50-100GB RAM (loaded models) |
| Warm | 5,000-10,000 | 250K-500K | ~20MB RAM (signatures) |
| Cold | 19,990,000 | ~999M | ~15GB (embedding index on SSD) |
| **Total** | **~20M** | **~1B** | **~100GB RAM + 15GB SSD** |

The cold tier index moves to SSD at this scale. Embedding lookups from NVMe SSD: ~0.1-1ms per lookup. Acceptable for background ticks.

**What hardware makes 1B memories possible at each phase:**

| Timeframe | Hardware | Bottleneck Solved | Memory Capacity |
|-----------|----------|-------------------|-----------------|
| Now (2026) | Mac Studio M3 Ultra 192GB | Tiered node management | ~750K-1M |
| 2027 | M4/M5 Ultra 512GB + NVMe | More RAM for hot nodes, faster SSD for cold index | ~5M-10M |
| 2027-2028 | Custom Apple Silicon cluster (2-4 Mac Studios networked) | Distributed hot tier across machines | ~50M-100M |
| 2028-2029 | Purpose-built inference servers (Groq, Cerebras, custom ASIC) | Sub-ms inference, persistent KV caches | ~500M-1B |
| 2029-2031 | Neuromorphic / in-memory compute | Eliminates von Neumann bottleneck entirely | 1B+ with real-time ticks |

**The three breakthroughs that unlock billions at real-time tick rates:**

1. **Persistent KV cache across ticks.** Today every node cold-starts each tick. If node models keep their KV cache warm between activations (Google's context caching is the first step), a node can resume in <1ms instead of reprocessing its whole neighborhood. This alone gets you 10x more nodes per tick budget. ETA: 2027-2028.

2. **Hardware-accelerated vector search at billion scale.** Current vector DBs (Pinecone, Qdrant) handle billions but add network latency. Purpose-built vector search on the same silicon as inference (e.g., in-memory search on the Mac's unified memory) eliminates the I/O hop for cold tier lookups. ETA: 2027-2029.

3. **Sub-millisecond model inference.** Groq is at ~40ms per token today. Cerebras is pushing lower. Custom ASICs designed for small model inference (1.5B-3B params) could hit <1ms per output token. At that speed, you activate 1,000 nodes in 1 second. 10,000 nodes in 10 seconds. The whole hot tier fires in real time. ETA: 2028-2030.

**The endgame vision (2030+):**

A single rack-mount unit running custom inference silicon holds:
- 1B+ memories in a tiered index
- 10,000+ hot nodes with persistent state
- 100K+ warm nodes with semantic signatures
- Ticks at 1/sec with 500-1,000 node activations per tick
- The memory system thinks continuously at human-equivalent speed
- Total cost: comparable to a high-end server today (~$20K-50K)

This is not science fiction -- it's the natural trajectory of inference hardware. Each component exists in early form today. The architecture is designed to absorb each breakthrough as it arrives.

### v4-v5: Dedicated Infrastructure
- Enterprise customers get dedicated lattice instances
- Multi-region deployment for latency-sensitive use cases
- Hybrid: nodes self-hosted on customer hardware, orchestrator + synthesis via API

---

## 9. Cost Projections

### Per-Pulse Cost (v1, via OpenRouter)

| Preset | Model | Est. Cost/pulse |
|--------|-------|-----------------|
| Potato | GPT-5 Nano | ~$0.001 |
| Low | Gemini 2.0 Flash-Lite | ~$0.002 |
| Medium | Gemini 2.5 Flash | ~$0.005 |
| High | GPT-4.1 Mini | ~$0.008 |
| Ultra | Gemini 3.1 Pro | ~$0.015 |
| Sonnet | Claude Sonnet 4.6 | ~$0.016 |

### Monthly Cost by Interval (v1, actual)

| Interval | Pulses/Day | Model (Medium) | Cost/Day | Cost/Month |
|----------|------------|----------------|----------|-----------|
| 60m | 24 | Gemini 2.5 Flash | $0.12 | ~$3.60 |
| 10m | 144 | Gemini 2.5 Flash | $0.72 | ~$21.60 |
| 1m | 1,440 | Gemini 2.5 Flash | $7.20 | ~$216 |
| 10s | 8,640 | Gemini 2.5 Flash | $43.20 | ~$1,296 |
| 1s | 86,400 | Gemini 2.5 Flash | $432 | ~$12,960 |
| Live (0ms) | Theoretical max | Gemini 2.5 Flash | Variable | Variable |

**Note:** These are inference costs only via OpenRouter. With batching, caching, and delta processing, real costs are estimated at 30-50% of theoretical. Sub-second intervals (Live, 1s, 3s, 5s) are available in v1 but should be used judiciously. Spend telemetry is visible in the dashboard.

### Per-Query Cost (v3, Lattice)

| Component | What | Cost |
|-----------|------|------|
| Nodes (5-15 activated) | Flash-tier calls | $0.01-0.03 |
| Orchestrator | Aggregation call | $0.02-0.05 |
| Synthesis | Top-tier final answer | $0.10-0.30 |
| **Total** | | **$0.13-0.38** |

Comparable to a single Opus call with 50K context ($0.15-0.75), but with better results because the lattice pre-processed the context.

---

## 10. Success Metrics

### v1 Metrics (Proof of Concept)
- **Anticipation hit rate:** % of MC recalls where a prospective trace was served and validated useful. Target: >15%.
- **Cost per tick:** actual inference cost. Target: <$0.01 at 1/min with Flash.
- **Trace precision:** % of generated traces that were eventually validated. Target: >25%.
- **Latency overhead:** added time to MC recall from trace checking. Target: <50ms.
- **Trace diversity:** even distribution across trace types (not all "query" predictions).

### v2 Metrics (Ensembles & Contradiction)
- **Contradiction detection rate:** % of known contradictions found. Target: >80%.
- **Resonance quality:** human rating of surfaced patterns. Target: >50% rated "useful."
- **Ensemble coherence:** memories in the same ensemble are semantically related. Target: >90% agreement with human labels.
- **False alarm rate:** contradictions/resonances flagged that aren't real. Target: <20%.

### v3 Metrics (Lattice)
- **Lattice vs. single-agent:** A/B test recall quality. Target: lattice wins >60% of cases.
- **Node activation latency:** time per node. Target: <500ms (API), <2s (self-hosted).
- **Horizontal scaling:** quality improves (not degrades) as nodes increase. Must demonstrate positive correlation.
- **Cost efficiency:** cost per query with lattice vs. equivalent direct model call. Target: lattice is cheaper at 5K+ memories.

### v5 Metrics (Endgame)
- **Self-organization:** lattice topology changes correlate with actual usage patterns.
- **Emergent specialization:** node expertise divergence measurable over time.
- **Continuous cognition:** 1 tick/sec sustained for 30+ days without degradation.
- **Anticipation hit rate at scale:** >50% at 100K+ memories (memory volume makes predictions easier, not harder).

---

## 11. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Anticipation doesn't help (traces are useless) | HIGH | v1 is cheap to test. Kill if hit rate <5% after 2 weeks. |
| Cost too high at 1/min tick rate | MEDIUM | Start with 1/hour. Optimize with delta processing and caching. |
| MC schema changes break existing users | MEDIUM | All additions are optional fields + new tables. No breaking changes. |
| Latency overhead on recall | LOW | Trace matching is a simple indexed query (<10ms). |
| Flash-tier models not smart enough for anticipation | MEDIUM | Start with Gemini 2.5 Flash (strong). Fall back to Sonnet if needed. |
| Self-hosted nodes compete for memory bandwidth | MEDIUM | Benchmark concurrency limits. Cap parallel nodes per hardware config. |
| Contradiction detection produces too many false positives | MEDIUM | Confidence threshold + human validation loop. Only surface high-confidence. |
| Lattice architecture doesn't produce emergent behavior | HIGH | v3 is months away. v1-v2 validate the core thesis (anticipation helps) before investing in lattice. |
| Ideas are noise, not signal (low-quality discoveries) | MEDIUM | Quality gate (confidence >= 0.7, multi-domain sources). Conservative mode available. User can dismiss/star to train quality. |
| Email notifications annoy users | LOW | Off by default. User opt-in only. Configurable frequency and delay. |
| Trace v2 still doesn't hit | MEDIUM | Research-backed fixes. 5 independent improvements — even partial success raises hit rate from 0%. Recall query log provides ongoing training signal. |

---

## 12. Competitive Position

| Feature | MC + Organic Memory | Mem0 | Cognee | Kumiho | Hermes Agent (NousResearch) |
|---------|-------------------|------|--------|--------|----------------------------|
| Memory storage | Yes | Yes | Yes | Yes | Yes (flat-file) |
| Graph structure | Yes | Yes | Yes | Yes | No |
| Vector search + scoring | **Yes (7 signals)** | Basic | Yes | Yes | No |
| Prospective traces | **Yes (shipped v1)** | No | No | Write-time only | No |
| Background thinking between turns | **Yes (pulse/fiber)** | No | No | No | No |
| Cross-domain idea discovery | **Yes (v1.1)** | No | No | No | No |
| Recall confidence scoring | **Yes (shipped)** | No | No | No | No |
| Notification pipeline (injection + email) | **Yes (v1.1)** | No | No | No | No |
| Contradiction detection | **Yes (v2)** | No | No | No | No |
| Resonance patterns | **Yes (v2)** | No | No | No | No |
| Distributed lattice | **Yes (v3)** | No | No | No | No |
| Tick-rate cognition | **Yes (sub-second shipped)** | No | No | No | No |
| Self-organizing topology | **Future (v5)** | No | No | No | No |
| Knowledge Bases | **Yes (shipped)** | No | No | No | No |
| Content security scanning | **In progress** | No | No | No | No |
| Open source base | MC is open, addon closed | Yes | Yes | No | Yes |

**The real moat is not prediction accuracy** — anyone can build that given enough engineering. The moat is:

1. **Background thinking between turns over the full memory corpus.** Nobody else does this. Every other system waits for a query. Organic Memory thinks continuously — processing, connecting, discovering — even when the user is asleep. The pulse/fiber architecture is a fundamentally different paradigm.

2. **Cross-domain connection discovery (Ideas).** The system discovers things about your memories YOU didn't know. Not summaries, not search results — genuine eureka moments synthesized from memories you forgot you had, connected to memories from a completely different context.

3. **The pulse/fiber architecture running continuously.** Each pulse spawns parallel fibers. Each fiber handles an independent concern. The architecture scales horizontally (more fibers) and vertically (faster pulses). New intelligence plugs in as a new fiber.

4. **Client-agnostic delivery.** Ideas and traces reach the user regardless of which AI client they're using — Claude Code, Codex, OpenClaw, Factory, any MCP client — because delivery lives in the plugin layer, not any single client.

Kumiho has write-time prospective indexing (closest to traces) but no runtime loop and no discovery. Mem0 markets "proactive" but the implementation is behavioral analytics, not memory inference. NousResearch Hermes Agent has a learning loop with periodic memory/skill nudges (turn-based, not tick-based) — their memory is flat-file with no vector search, no scoring, no ranking.

---

## 13. Open Questions

1. **Evaluation framework:** How do you benchmark anticipatory memory? No standard benchmark exists. We may need to create one (and publish it for credibility).
2. **Privacy:** Prospective traces contain predictions about user behavior. How transparent should we be about what the system is predicting? (Default: fully transparent -- users can see all traces.)
3. **Multi-tenant lattice:** In managed cloud, do users share node infrastructure or get isolated lattices? (Default: isolated per user for privacy.)
4. **Trace TTL calibration:** How long should prospective traces live before expiring? Too short = wasted compute, too long = stale predictions. (Start with: query traces 1h, context traces 4h, contradiction traces 24h, resonance traces 7d.)
5. **Patent:** Should we file a provisional patent on the prospective memory engine + tick-rate cognition architecture? The competitive landscape suggests yes -- Kumiho already has a patent pending on their write-time approach.
6. **Embedding replacement timeline:** At what point does the lattice produce better semantic signals than embeddings? Need to measure this empirically in v3.

---

## 14. Timeline Summary

| Phase | Version | Original Est. | Actual / Revised | Key Deliverable |
|-------|---------|---------------|------------------|-----------------|
| Pulse Engine | v1.0 | Weeks 1-4 (Apr 2026) | **✅ Shipped Mar 28-29** (2 days) | Self-scheduling pulse, traces, models, dashboard, KBs |
| Fibers + Ideas + Trace v2 + Notifications | v1.1 | Weeks 5-6 (May 2026) | **🔧 In progress (Mar 30-31)** | Fiber architecture, ideas discovery, trace v2 (document embeddings, predict-calibrate), notification pipeline, dashboard sub-nav, conversation-reactive pulse, security scanning, procedural extraction |
| Ensembles | v2.0 | Weeks 7-12 (Jun-Jul 2026) | Apr-May 2026 (revised) | Memory clusters, motifs, conflict groups, ensemble fibers |
| Contradiction/Resonance | v2.1 | Weeks 13-16 (Aug 2026) | May-Jun 2026 (revised) | Active detection and surfacing |
| Lattice | v3.0 | Weeks 17-28 (Sep-Nov 2026) | Jul-Sep 2026 (revised) | Distributed node models, orchestrator layer |
| 1 Tick/Sec | v3.1 | Weeks 29-32 (Dec 2026) | Oct 2026 (revised) | Enterprise-grade continuous cognition |
| Synthesis | v4.0 | Weeks 33-40 (Jan-Feb 2027) | Nov-Dec 2026 (revised) | Full three-layer lattice, prepared thought surfaces |
| Endgame | v5.0 | 2028-2031 | 2028-2031 (unchanged) | Self-organizing topology, persistent state, sub-ms inference |
| Invention Loop | v6.0 | 2030+ | 2030+ (unchanged) | Self-reflection, hypothesis generation, hardware proposals, the loop |

**Velocity note:** v1.0 was estimated at 4 weeks; shipped in 2 days. v1.1 scope expanded 4x from the original estimate (was: trace serving + validation; now: fibers + ideas + trace v2 + notifications + sub-nav + conversation-reactive + security + procedural extraction). Despite the scope expansion, actual development velocity suggests v1.1 ships in days, not weeks. The original timeline estimates were based on typical team velocity — actual velocity with AI-assisted development is 10-20x faster. Downstream milestones adjusted accordingly.

The stub files for ensembles (624 lines), contradictions (495 lines), and resonance (299 lines) were scaffolded during v1.0, further accelerating v2.0.

---

## 15. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-27 | OMG Engine is separate from MC, not an upgrade | Different buyers, infra, failure modes. Clean decoupling. |
| 2026-03-28 | Renamed to "Organic Memory" as MC addon | Simpler positioning. "Adds real thinking to your memory." |
| 2026-03-28 | Tick-rate as pricing axis | Cognition frequency = product tier. Unique differentiator. |
| 2026-03-28 | v1 = single tick agent, not full lattice | Ship simple first. Validate core thesis before investing in lattice. |
| 2026-03-28 | Runs as Convex scheduled function (v1) | Minimizes infra. Uses MC's existing backend. |
| 2026-03-28 | Prospective traces added to MC schema | Not external. Tight integration. |
| 2026-03-28 | Closed source (for now) | Lattice architecture is the moat. Can open later. |
| 2026-03-28 | Build functionality first, pricing later | "Get functionality working first, judge costs then figure out pricing." -- Andy |
| 2026-03-29 | Renamed "tick" to "pulse" for external branding | Pulse is brand-friendly and evocative. Tick remains internal terminology. |
| 2026-03-29 | Knowledge Bases as first-class MC entity | Enrichable but not decayable. Reference material needs persistence, not decay. |
| 2026-03-29 | OpenRouter for unified cost tracking | Routes all model calls (Gemini, OpenAI, Anthropic) through single billing layer. |
| 2026-03-29 | Interval tiers include sub-second options | Live (0ms), 1s, 3s, 5s available. Self-scheduling via runAfter makes this trivial. |
| 2026-03-29 | 6 model presets across 3 providers | User choice from Potato (cheapest) to Sonnet (most capable). Per-user config. |
| 2026-03-29 | crystal_forget for memory lifecycle | Archive or permanently delete. Ownership verification + rate limiting. |
| 2026-03-30 | Conversation-reactive pulse | Pulse fires based on conversation content, not just timer. Inspired by NousResearch Hermes Agent's learning loop. |
| 2026-03-30 | Procedural memory auto-extraction | Tick engine detects workflow patterns and auto-creates procedural memories with dedup. |
| 2026-03-30 | Memory content security scanning on write path | Pattern-based scanner for prompt injection, role hijacking, exfiltration attempts. |
| 2026-03-30 | Recall confidence scoring with 7 ranking signals | Vector, strength, freshness, salience, text match, continuity, access. Mandatory acknowledgment for high-confidence. |
| 2026-03-31 | Fibers as parallel pulse processing strands | Neural/mycelial metaphor. Each fiber handles an independent concern within a single pulse. Enables parallel processing without blocking. |
| 2026-03-31 | Ideas feature — cross-memory eureka discoveries | Higher-order than traces. Synthesize across multiple memories/domains to produce genuinely novel insights the user hasn't seen. |
| 2026-03-31 | Two-tier notification: next-turn injection + email digest | Injection works across all clients (plugin layer). Email fallback after configurable delay. Client-agnostic delivery. |
| 2026-03-31 | Organic dashboard sub-navigation split | Overview / Ideas / Traces / Ensembles / Settings. One 903-line page.tsx was unsustainable. |
| 2026-03-31 | Trace Prediction v2 — document embeddings, predict-calibrate, warm cache | 0/7,295 validated traces. Root cause: query-to-query matching doesn't work. Fix: document embeddings, cosine 0.40, recall query log, blind-spot-only prediction. |
| 2026-03-31 | Research basis: VoiceAgentRAG, Nemori, Hindsight | VoiceAgentRAG (75% hit rate, document descriptions), Nemori (predict-calibrate), Hindsight (83-91% accuracy, structured memory). Applied to trace v2. |

---

## 16. What Shipped vs. What Changed

A summary of key implementation decisions that differed from the original PRD spec.

| Area | PRD Planned | What Actually Shipped | Why |
|------|------------|----------------------|-----|
| Naming | "Tick" throughout | "Pulse" externally, "tick" internally | Brand-friendly. Pulse evokes life, tick evokes machinery. |
| Model selection | Gemini 2.5 Flash / Sonnet 4.5 | 6 presets: Potato, Low, Medium, High, Ultra, Sonnet | Users want cost/quality control. One model doesn't fit all use cases. |
| API routing | Direct provider calls | All calls via OpenRouter | Unified billing, cost tracking, provider abstraction. |
| Tick intervals | 1/hour, 1/min (1/sec deferred to v3) | Live (0ms) through 60m, sub-second available now | Self-scheduling via runAfter made sub-second trivial. No reason to defer. |
| Scheduling | Cron-based scheduled function | Self-scheduling via runAfter; cron = heartbeat/recovery only | More reliable for sub-minute intervals. Cron can't do sub-second. |
| Knowledge Bases | Not in PRD | First-class entity, enrichable, not decayable | Emerged as necessary during implementation. Reference material is different from episodic memory. |
| Recall Intelligence | Not in PRD | 7-signal confidence scoring, mandatory acknowledgment | Needed to close the loop on trace serving quality. Without ranking, recall is just search. |
| crystal_forget | Not in PRD | Archive + permanent delete with ownership verification | Memory lifecycle requires deletion, not just creation. |
| Content security | Not in PRD (v1.1) | Pattern-based injection/exfiltration scanner on write path | Memory is an attack surface. Must protect before it's exploited. |
| Conversation-reactive | Not in PRD (v1.1) | Pulse fires on conversation content, not just timer | Inspired by Hermes Agent. Timer-only misses conversational context. |
| Procedural extraction | Not in PRD (v1.1) | Auto-detect workflow patterns, create procedural memories | Users repeat workflows. The system should learn them automatically. |
| Timeline | v1.0 in 4 weeks | v1.0 in 2 days | Convex + existing MC infrastructure made it faster than expected. |
| Stub files | Not planned | Ensembles (624 lines), contradictions (495 lines), resonance (299 lines) scaffolded | Built during v1.0 momentum. Not active yet but accelerates v2.0. |
| Pulse architecture | Sequential steps within pulse | Parallel fibers within pulse | Independent concerns should run in parallel. Fibers = neural/mycelial metaphor. |
| Ideas | Not in PRD | Cross-memory eureka discovery with organicIdeas table | Traces predict questions; ideas discover connections. Higher-order cognition. |
| Notifications | Not in PRD | Two-tier: next-turn injection + email digest | Ideas are worthless if unseen. Plugin-layer injection works across all clients. |
| Trace matching | Query-to-query embeddings, cosine 0.85 | Query-to-document embeddings, cosine 0.40 | 0/7,295 validated. Research (VoiceAgentRAG, Nemori, Hindsight) identified root cause and fix. |
| Trace strategy | Predict everything, 10 per pulse | Predict-calibrate (blind spots only), 3 per pulse | Fewer, sharper predictions from better targeting. Quality over quantity. |
| Dashboard | Single organic page | Sub-routes: Overview/Ideas/Traces/Ensembles/Settings | 903-line page.tsx was unsustainable. Each concern gets its own route. |
| v1.1 scope | Trace serving + validation | Fibers + ideas + trace v2 + notifications + sub-nav + 3 more features | Scope grew 4x as architecture solidified. Velocity supports it. |

---

*Document maintained by Gerald Sterling. Last updated: March 31, 2026.*