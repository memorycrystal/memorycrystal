# MetaClaw Feature Adoption Plan for Memory Crystal

**Date:** 2026-04-01
**Source analysis:** github.com/aiming-lab/MetaClaw
**Prior competitive analyses:** Hermes Agent (skill_manage), DAG-based summary cascading

---

## Executive Summary

Four features from MetaClaw are worth adapting into Memory Crystal Organic. None require RL training infrastructure or GPU resources. All four build on top of existing Organic infrastructure (tick loop, fibers, recall pipeline, recall logs, procedural extraction).

**Priority order by impact-to-effort ratio:**

1. **Recall Policy Self-Tuning** (HIGH impact, MEDIUM effort) — v1.2 timeframe
2. **Replay Evaluation Framework** (HIGH impact, MEDIUM effort) — v1.2 timeframe
3. **Skill Auto-Creation from Failure Patterns** (HIGH impact, HIGH effort) — v2.2 timeframe
4. **Generation-Tracked Sample Invalidation** (MEDIUM impact, LOW effort) — v1.1 patch

---

## Feature 1: Recall Policy Self-Tuning

### What MetaClaw does
`MemorySelfUpgradeOrchestrator` generates candidate memory policies (tweaked retrieval parameters), evaluates each against replay samples, scores on a composite metric, and promotes winners. Full pipeline: generate → evaluate → compare → promote/reject.

### What we already have
- `recallRanking.ts` with explicit, tunable weights:
  ```typescript
  defaultRecallRankingWeights = {
    vectorWeight: 0.3,
    strengthWeight: 0.22,
    freshnessWeight: 0.15,
    accessWeight: 0.06,
    salienceWeight: 0.14,
    continuityWeight: 0.08,
    textMatchWeight: 0.12,
  };
  ```
- `organicRecallLog` table logging every recall query with results
- `organicRecallStats` table with aggregated stats per user
- `organicTickState` tracking tick history per user

### What we build

**New table: `organicRecallPolicies`**
```
userId, weights (the 7 recall ranking weights), isActive (bool),
score (composite evaluation score), evaluatedAt, promotedAt,
generation (integer, increments on promotion), parentGeneration,
status: "candidate" | "evaluating" | "active" | "rejected"
```

**New file: `convex/crystal/organic/policyTuner.ts`**

Core flow (runs as a fiber inside `processUserTick`, gated to once per 24h):
1. Load current active weights from `organicRecallPolicies` (or defaults)
2. Generate 3-5 candidate weight sets by perturbing current weights (±10-20% per dimension, clamped, normalized to sum=1)
3. Load last 50 recall queries from `organicRecallLog` (the replay samples)
4. For each candidate: re-rank the stored result sets using candidate weights, score against actual user behavior (did the user access the returned memories? did recall lead to a follow-up action?)
5. Compare candidate scores against baseline (current active policy)
6. If best candidate beats baseline by >5% composite score: promote (update active policy)
7. Log all evaluations for dashboard visibility

**Scoring function (adapted from MetaClaw's composite):**
- `queryOverlap`: term overlap between recall query and returned memory titles/content
- `accessDelta`: did recalled memories get accessed more after being surfaced?
- `followUpRate`: ratio of recalls that led to a user action within 10 minutes
- `diversityScore`: category/store distribution of results (penalize mono-category)

**Dashboard addition: Organic > Settings > Recall Tuning**
- Show current active weights
- Show policy history (generations, scores, promotions)
- Manual override toggle (let users lock weights)
- Evaluation frequency control

### Files touched
- NEW: `convex/crystal/organic/policyTuner.ts` (~300 lines)
- EDIT: `convex/crystal/organic/tick.ts` (add policyTuner fiber call, gated)
- EDIT: `convex/crystal/recallRanking.ts` (accept per-user weights override)
- EDIT: `convex/schema.ts` (add `organicRecallPolicies` table + indexes)
- EDIT: `apps/web/app/organic/settings/page.tsx` (recall tuning UI)

### Effort estimate: 3-4 days (2 agents)

---

## Feature 2: Replay Evaluation Framework

### What MetaClaw does
`replay.py` loads conversation samples, runs memory retrieval against each with both baseline and candidate policies, computes composite scores (query overlap, response overlap, focus, grounding, coverage, value density), writes comparison reports.

### What we already have
- `organicRecallLog` stores every recall query + results + timing
- `organicRecallStats` has aggregated metrics
- Traces have hit/miss tracking via validation

### What we build

**New file: `convex/crystal/organic/replayEval.ts`**

The key insight from MetaClaw: measure whether memory retrieval *actually helped the agent give a better response*. We can approximate this without intercepting responses by using our existing data:

**Evaluation pipeline (internal action, runs weekly or on-demand from dashboard):**
1. Sample last 200 recall queries from `organicRecallLog`
2. For each query, check:
   - **Grounding score**: how many of the returned memories were actually referenced in follow-up messages? (requires `crystal_search_messages` cross-reference or activity log correlation)
   - **Coverage score**: for memories the user accessed within 30 min of recall, were any NOT in the recall results? (missed relevant memories)
   - **Precision**: what fraction of returned memories were accessed/useful?
   - **Recall latency correlation**: did faster recalls correlate with better grounding?
3. Produce a `replayReport` document with aggregate scores + worst-performing queries
4. Surface on dashboard: Organic > Traces (new "Recall Quality" tab)

**This directly feeds Feature 1** — the policy tuner uses replay eval scores as its fitness function.

**Dashboard: Organic > Traces > Recall Quality**
- Aggregate scores over time (line chart)
- Worst-performing queries (table with scores)
- Score breakdown by memory store/category
- Week-over-week trend

### Files touched
- NEW: `convex/crystal/organic/replayEval.ts` (~250 lines)
- NEW: `convex/crystal/organic/replayReport.ts` (queries for dashboard, ~100 lines)
- EDIT: `convex/schema.ts` (add `organicReplayReports` table)
- EDIT: `apps/web/app/organic/traces/page.tsx` (recall quality tab)

### Effort estimate: 2-3 days (1-2 agents)

---

## Feature 3: Skill Auto-Creation from Failure Patterns

### What MetaClaw does
`SkillEvolver` clusters failed conversation samples by failure type, prompts an LLM to generate new `SKILL.md` files targeting those failure modes, bumps a "generation" counter, invalidates pre-evolution samples.

### What we already have
- `proceduralExtraction.ts` (530 lines) — already extracts workflow patterns from memories and creates procedural memories
- Procedural memories are already surfaced in recall
- Ideas system — discovers cross-memory connections
- MCP tools for memory management

### What we build

This is the most MetaClaw-specific feature and the one Andy flagged. The key difference from their approach: **we don't auto-deploy skills, we suggest them through the Ideas system with human review.**

**Extend `proceduralExtraction.ts` with a skill suggestion path:**

1. During the procedural extraction fiber, after extracting workflow patterns, add a second pass:
   - Analyze the last N procedural memories for recurring failure/retry patterns
   - Cross-reference with recall log: queries that returned poor results (low grounding scores from Feature 2)
   - Identify "skill gaps" — situations where the agent needed knowledge it didn't have

2. When a skill gap is identified:
   - Generate a candidate `SKILL.md` file content via the tick model
   - Create an `organicIdea` with type "skill_suggestion" containing:
     - Suggested skill name, description, and content
     - Evidence (which memories/queries triggered it)
     - Confidence score
   - Surface via existing Ideas delivery (plugin injection + email digest + MCP + dashboard)

3. User reviews in dashboard: Organic > Ideas > Skill Suggestions
   - Accept → writes SKILL.md to their OpenClaw skills directory (via MCP or plugin)
   - Edit → modify before accepting
   - Dismiss → logged, pattern deprioritized

**New table: `organicSkillSuggestions`**
```
userId, skillName, description, content (SKILL.md body),
evidence (array of memory/query IDs), confidence,
status: "pending" | "accepted" | "modified" | "dismissed",
generation (tracks which tick produced it)
```

**MetaClaw's generation tracking adapted:**
When a skill suggestion is accepted, tag all recall log entries from before that point with the pre-skill generation. The replay eval (Feature 2) can then measure whether recall quality improved post-skill-adoption.

### Files touched
- EDIT: `convex/crystal/organic/proceduralExtraction.ts` (add skill gap analysis, ~150 new lines)
- NEW: `convex/crystal/organic/skillSuggestions.ts` (~200 lines)
- EDIT: `convex/crystal/organic/ideas.ts` (add skill_suggestion type handling)
- EDIT: `convex/schema.ts` (add `organicSkillSuggestions` table)
- EDIT: `apps/web/app/organic/ideas/page.tsx` (skill suggestion UI)
- EDIT: `plugin/index.js` (skill write-back if accepted via MCP)
- EDIT: `mcp-server/src/tools/` (new `crystal_suggest_skill` tool)

### Effort estimate: 5-7 days (2-3 agents)

---

## Feature 4: Generation-Tracked Sample Invalidation

### What MetaClaw does
MAML-inspired: when skills evolve (generation bump), pre-evolution RL samples are discarded to prevent stale reward signals from poisoning training.

### What we already have
- Recall logs with timestamps
- Trace predictions with validation tracking
- Policy tuner (Feature 1) will have generation tracking

### What we build

This is the simplest adaptation — just add a `generation` field to key tables:

1. Add `policyGeneration: v.optional(v.number())` to `organicRecallLog` entries
2. When the policy tuner promotes a new policy (Feature 1), increment generation
3. When replay eval runs (Feature 2), partition scores by generation
4. Report "pre-policy vs post-policy" quality delta on dashboard
5. Option to exclude pre-generation samples from policy evaluation (prevents stale patterns from biasing future tuning)

Same pattern for skill suggestions (Feature 3): when a skill is accepted, bump skill generation, track which recall logs were pre vs post skill adoption.

### Files touched
- EDIT: `convex/crystal/organic/traces.ts` (add generation to logRecallQuery)
- EDIT: `convex/crystal/organic/policyTuner.ts` (generation increment on promote)
- EDIT: `convex/crystal/organic/replayEval.ts` (partition by generation)
- EDIT: `convex/schema.ts` (add generation field to organicRecallLog)

### Effort estimate: 0.5-1 day (1 agent, can bundle with Feature 1)

---

## Implementation Schedule

### Phase A — Foundation (v1.1 patch, 1-2 days)
- Feature 4: Add generation tracking to recall logs and schema
- Prerequisite for Features 1 and 2

### Phase B — Evaluation + Tuning (v1.2, 5-7 days)
- Feature 2: Replay evaluation framework
- Feature 1: Recall policy self-tuning (depends on Feature 2 for scoring)
- These two are tightly coupled — build together

### Phase C — Skill Evolution (v2.2, 5-7 days)
- Feature 3: Skill auto-creation from failure patterns
- Depends on Features 1+2 being stable (uses replay eval for measuring impact)
- Also depends on the discovery fiber gap being fixed first (GAP 1 from pipeline audit)

### Total: ~12-16 days across 4-6 agents

---

## What We're NOT Taking from MetaClaw

1. **RL training loop** — requires GPU infrastructure (Tinker), we're a cloud SaaS product
2. **Proxy architecture** — we use plugins/MCP, not API interception
3. **SQLite memory store** — we have Convex (cloud, multi-user, real-time)
4. **Idle-time scheduling** — our tick loop already handles this via configurable intervals; adding user-idle detection adds complexity for minimal gain in a cloud context
5. **PRM (Process Reward Model)** — requires dedicated judge model; our replay eval approach uses behavioral signals instead (cheaper, no extra model calls)

---

## Dependencies and Risks

1. **GAP 1 must be fixed first**: The discovery fiber that creates Ideas doesn't exist yet. Feature 3 (skill suggestions) routes through Ideas. Fix the discovery fiber before building Feature 3.
2. **GAP 2 should be fixed**: Conversation pulse wiring in plugin enables richer recall log data, which improves Features 1 and 2.
3. **Recall log volume**: Features 1 and 2 need sufficient recall log data (50+ queries) to be useful. New users won't benefit until they've been using MC for a week+.
4. **Weight normalization**: Policy tuner must ensure weights always sum to ~1.0 and no single weight dominates (>0.5). MetaClaw handles this; we need the same guard.
5. **User override**: Some users will want to manually set recall weights. The policy tuner must respect a "locked" flag and not override manual preferences.
