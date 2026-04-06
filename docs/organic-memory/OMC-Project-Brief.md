# Organic Memory Crystal (OMC) — Project Brief

**Author:** Andy Doucet
**Date:** March 27, 2026
**Status:** Concept / Pre-development
**Codename:** OMG (Organic Memory Graph)

---

## Executive Summary

Memory Crystal is an AI agent memory system that stores, retrieves, and enriches memories across sessions. It works. But every competitor in the space is converging on the same playbook: store memories, build graphs, retrieve context.

Organic Memory Crystal (OMC) is the next evolution — a memory system that doesn't just remember the past, but **anticipates the future**. Powered by the Organic Memory Graph (OMG), it introduces prospective memory, background anticipation, and resonance detection as first-class primitives.

The thesis: today's memory systems are retrospective. The next category is prospective. That shift is from smart librarian to prepared operator.

---

## The Problem

Every AI memory system today works the same way:

1. User says something
2. System searches memory
3. System returns relevant results
4. Model reasons with those results

This is **reactive retrieval**. It's better than nothing, but it means the agent is always one step behind — assembling context after the question arrives, never before.

Human cognition doesn't work this way. When you walk into a meeting, your brain has already activated relevant memories, anticipated likely topics, and prepared response patterns. You don't search your memory when someone asks a question — your memory has already surfaced what you need.

No AI memory system does this today.

---

## Architectural Decision: Separate Products

**OMG Engine is a separate product, not an MC upgrade.**

Memory Crystal is a memory layer. It stores, retrieves, enriches, and serves memories. The OMG Engine is a cognition layer -- lattice architecture, anticipation, resonance, prospective traces. Different buyer, different infrastructure, different failure modes, different pricing.

### Product Map

| Product | Role | Status |
|---------|------|--------|
| Memory Crystal (MC) | The memory layer. Open source base, managed cloud tiers. | Shipping |
| OMG Engine | The cognition layer. Expansion pack for MC. Separate product, repo, pricing. | Concept |
| Organic Memory Crystal (OMC) | The bundle brand. "MC + OMG = OMC." | Future |

### Integration Surface (MC ↔ OMG)

OMG needs exactly three things from MC:
1. **Read memories** -- via MC's existing recall/search API
2. **Write prospective traces** -- new memory type in MC (lightweight schema addition)
3. **Receive activity signals** -- webhooks/polling for "new memory stored" / "recall requested"

MC doesn't need to know the lattice exists. Clean decoupling.

---

## The Vision

### Memory Crystal → Organic Memory Crystal

**Memory Crystal (current):**
- Store memories (episodic, semantic, procedural, prospective, sensory)
- Retrieve via search, recall, and adaptive context injection
- Graph enrichment and relationship tracking
- Cross-session persistence

**Organic Memory Crystal (next):**
- Everything above, plus:
- **Prospective traces** — provisional future-oriented memory objects
- **Background anticipation** — selective passes that predict what context will be needed
- **Memory ensembles** — clusters, motifs, conflict groups, and trajectories
- **Resonance and contradiction detection** — weak patterns and direct conflicts surfaced automatically
- **Prepared thought surfaces** — pre-assembled context delivered before the prompt

### The Engine: Organic Memory Graph (OMG)

The OMG is the multidimensional memory structure underneath OMC. Each memory node tracks:

- **Semantic topic** — what it's about
- **Temporal position** — when it happened and its time horizon
- **Causal links** — what caused it and what it caused
- **Agentic source** — which agent/session produced it
- **Counterfactual weight** — what would be different if this memory were false
- **Confidence score** — how certain we are
- **Contradiction flags** — known conflicts with other memories
- **Reinforcement frequency** — how often this memory is accessed or confirmed
- **Future-likelihood** — probability of relevance to upcoming queries
- **Actionability** — whether this memory implies a pending action

---

## Competitive Landscape

### The Market (March 2026)

The AI agent memory space has ~$40M+ in visible funding across major players, all converging on retrospective memory.

#### Tier 1: Well-Funded, Retrospective Only

| Company | Funding | Focus | Anticipatory? |
|---------|---------|-------|---------------|
| Mem0 | $24M | Memory layer for AI apps | No |
| Cognee | $7.5M | Open-source memory with knowledge graphs | No |
| Zep/Graphiti | Funded | Temporal knowledge graph | No |
| Letta | Funded | Stateful agent framework | No |

#### Tier 2: Closest to OMC Concept

| Company | Status | What They Do | How Close? |
|---------|--------|-------------|------------|
| Kumiho | Patent pending | Graph-native memory with "prospective indexing" at write-time | Closest technically — but write-time only, not runtime. Focus split with creative asset versioning. |
| MemU | Early-stage open source | Markets "proactive 24/7 agents" with intention prediction | Closest in positioning — but execution looks like behavioral analytics, not deep memory inference. |
| MemOS 2.0 | Enterprise | "Intent-aware scheduling" and async memory preloading | Infrastructure-level — OS scheduler prefetching, not cognitive anticipation. |

#### Tier 3: Adjacent / Different Domain

| Company | Funding | Domain |
|---------|---------|--------|
| Memories.ai | $8M | Visual memory for wearables/robotics |
| OpenMemory | Unknown | Local cognitive memory (5 sectors) |
| 0GMem | Unknown | Structured conversational memory |
| Hindsight | Unknown | Retain, recall, reflect (research) |

### What Exists vs. What Doesn't

**EXISTS:**
- Memory storage (everyone)
- Memory retrieval with graph structure (Mem0, Cognee, Zep, 0GMem)
- Write-time prospective indexing (Kumiho only)
- Behavioral prediction on top of memory (MemU claims)
- Infrastructure-level memory prefetching (MemOS)
- Speculative execution for speed (academic research)

**DOES NOT EXIST:**
- A runtime maintaining live future hypotheses grounded in persistent memory
- Background anticipation passes forming speculative memory bundles
- Resonance and contradiction detection across the memory field
- "Prepared thought surfaces" delivered to the model before the prompt
- Memory that participates in reasoning, not just feeds it
- The full prospective memory engine

### Key Research Papers

- "Memory in the Age of AI Agents" — comprehensive survey (arxiv 2512.13564)
- "Can We Predict the Next Question?" — collaborative filtering for user intent (arxiv 2511.12949)
- "Graph-Native Cognitive Memory" — Kumiho's prospective indexing paper (arxiv 2603.17244)
- "Speculative Actions" — agent acceleration via speculation (arxiv 2510.04371)
- "ContextAgent" — context-aware proactive agents (arxiv 2505.14668)
- MAGMA — multi-graph agentic memory (arxiv 2601.03236)
- A-MEM — agentic memory with dynamic structuring (arxiv 2502.12110)
- MemOS — memory OS for AI systems (arxiv 2507.03724)

---

## Product Architecture

### Phased Roadmap

**Phase 1: Typed Multidimensional Memory**
Add rich dimensions to every memory node. Each memory carries semantic, temporal, causal, agentic, confidence, contradiction, reinforcement, future-likelihood, and actionability scores. This is the foundation — you can't do anticipation over flat memory records.

**Phase 2: Memory Ensembles**
Instead of returning single memories, generate: clusters, motifs, conflict groups, trajectories, project arcs, unresolved threads. Move from memory records to memory structures. This enables reasoning over memory topology, not just memory content.

**Phase 3: Prospective Traces**
New memory type: predicted next question, likely follow-up task, pending clarification, likely missing document, likely action branch. These are provisional — they expire or get validated as reality unfolds. This is the "future memory" concept.

**Phase 4: Background Anticipation Jobs**
Selective background passes: what is the user likely to ask next in this thread? What files should be prefetched? What contradiction should be resolved first? What summary should be prebuilt? What open loops are likely to resurface? Not constant, not expensive — targeted anticipation.

**Phase 5: Resonance and Contradiction Engine**
Compute: weak reinforcing patterns across distant memories, direct contradictions, stale assumptions likely to cause future mistakes. This creates the "thinking with memory" feel — the system surfaces connections and conflicts the user hasn't asked about.

**Phase 6: Full Prospective Memory Engine**
The complete runtime: watches the evolving memory field, predicts likely future intents, spins up lightweight parallel evaluators, forms speculative memory bundles, ranks by expected usefulness, retires or confirms as reality unfolds. Analogous to CPU branch prediction / DNS prefetch / speculative execution — but for memory and cognition.

### Key Analogies

| Computer Science | OMC Equivalent |
|-----------------|----------------|
| DNS prefetch | Pre-resolve likely memory queries |
| Branch prediction | Predict which memory paths will be needed |
| Speculative execution | Run anticipation passes in background |
| L1/L2/L3 cache | Hot/warm/cold memory layers by predicted relevance |
| Write-ahead logging | Prospective traces as provisional future records |

---

## Why Now?

Three converging trends make this the right time:

1. **Inference costs are dropping fast.** Background anticipation passes that cost $10/day in 2025 will cost $0.50/day in 2027. The economics of continuous memory computation are becoming viable.

2. **Agent autonomy is increasing.** As agents run 24/7, work across sessions, and handle complex multi-step tasks, the cost of "reactive retrieval" increases. An agent that anticipates is exponentially more capable than one that only responds.

3. **The memory layer is becoming standard.** Every major agent framework is adding memory. But they're all adding the same kind of memory — retrospective. The opportunity is to leapfrog to prospective while the market is still converging on v1.

---

## The Moat

Memory Crystal's advantage is not that it can store memory. Everyone is going there.

The advantage is that it can turn memory into an **active, anticipatory layer for cognition**.

- Living memory states
- Prospective memory objects
- Parallel background activation
- Resonance and contradiction detection
- Future-oriented preparation before prompt

Others are building memory DBs, memory graphs, memory OSes.

We can build **memory that prepares, anticipates, and participates in reasoning before it is queried.**

That's a category move.

---

## Naming

| Layer | Name | Acronym |
|-------|------|---------|
| Base product | Memory Crystal | MC |
| Next-gen product | Organic Memory Crystal | OMC |
| Underlying engine | Organic Memory Graph | OMG |

"OMG" as the core tech acronym is free marketing. Every developer who encounters it will remember it.

---

## Technical Architecture: Crystalline Lattice

Andy's core vision: distributed cognition over a memory graph. Many small models each responsible for a local neighborhood of memory, communicating results to form emergent intelligence. Closer to biological neural networks than anything in the current AI memory landscape.

### The Three Layers

**1. Memory Nodes (lattice points)**
Each memory cluster gets its own lightweight model instance -- a "node model." It knows its local neighborhood: the 5-50 memories in its cluster, their relationships, their temporal patterns, their contradiction state. No single node needs to see the whole graph.

**2. Orchestrator Layer (lattice bonds)**
Orchestrator nodes sit between memory clusters and handle: routing queries to the right neighborhoods, aggregating responses from multiple nodes, detecting resonance (two distant nodes producing aligned signals), detecting contradiction (two nodes producing conflicting signals), and forming speculative bundles from cross-node patterns.

**3. Synthesis Layer (crystal face)**
A single higher-capability model receives pre-assembled, pre-evaluated results from the lattice and produces the final output. Needs almost no context -- the lattice has already done the heavy lifting.

### Model Selection

| Role | Models | Cost per activation |
|------|--------|-------------------|
| Node (workhorses, many) | Gemini 2.0 Flash, Gemini 3.1 Flash Lite, Haiku 4.5, GPT-5.3-codex-spark | $0.01-0.05 |
| Orchestrator (coordinators, fewer) | Gemini 2.5 Flash, Sonnet 4.5 | $0.05-0.20 |
| Synthesis (brain, one per query) | Opus, GPT-5.4 | $0.10-0.50 |
| Embedding (bootstrap) | text-embedding-3-large or Gemini embedding | Minimal |

Key insight: embeddings are just the bootstrap. Once the lattice is running, node models produce richer semantic signatures than any embedding model. The lattice replaces embeddings over time.

### Scaling Properties

- No single model needs large context (50 memories per node max)
- More memories = more nodes, not bigger context (horizontal scaling)
- More nodes = more intelligence (emergent cross-node patterns)
- Embarrassingly parallel (node activations are independent)
- The graph IS the intelligence -- not any single model, but the lattice as a whole

### Cost Math (5,000 memories / 100 clusters)

- Query activates 5-15 clusters, each with ~2K tokens of context
- Node layer: 5-15 Flash calls at ~$0.002 each = $0.01-0.03
- Orchestrator: one aggregation call = $0.02-0.05
- Synthesis: one top-tier call with pre-chewed context = $0.10-0.30
- **Total: ~$0.15-0.40 per query** (comparable to a single Opus call with 50K context, but better results)
- Background anticipation (100 passes/hour): ~$15-70/day depending on model tier

### Hardware Requirements

**Prototype:** Single server (Mac Mini or $20/mo VPS) + API keys. ~$50-200/mo inference.

**Scale (10K+ memories):** Dedicated orchestrator processes, async job queue (BullMQ, Temporal), possibly self-hosted small models for node layer.

**Large scale (100K+ memories):** Self-hosted Llama/Qwen/Gemma for node models on GPU. 4x T4 or 1x A10G handles ~50 concurrent 7B-13B instances. Breaks even vs API at ~500K node activations/month.

### Prototype Timeline

| Week | Milestone |
|------|-----------|
| 1-2 | Memory graph + cluster assignments + node model wrapper |
| 3-4 | Orchestrator layer (router, aggregator, resonance detector) |
| 5-6 | Background anticipation + prospective traces + contradiction scanner |
| 7-8 | Synthesis layer + Memory Crystal integration + prepared thought surfaces |

---

## Next Steps

1. Write technical architecture spec for Phase 1 (typed multidimensional memory)
2. Design the prospective trace schema
3. Prototype background anticipation as a Memory Crystal plugin
4. Build evaluation framework (how do you benchmark anticipatory memory?)
5. Write the landing page / positioning copy
6. File provisional patent on the prospective memory engine architecture

---

# Lean Canvas — Organic Memory Crystal

## Problem
1. AI agents forget everything between sessions — no persistent memory
2. Existing memory systems are purely reactive — they search after the question, never prepare before it
3. Agents feel like "smart search" not "prepared operator" — the memory layer is a bottleneck to agent intelligence

## Customer Segments
- AI agent developers building always-on assistants
- Enterprise teams deploying customer-facing AI with session continuity
- AI-native companies building autonomous agent workforces
- Developers using frameworks like LangChain, CrewAI, AutoGen, OpenClaw who need memory

## Unique Value Proposition
**The first memory system that anticipates, not just remembers.**

Memory Crystal gives your AI agents persistent memory today.
Organic Memory Crystal gives them the ability to prepare for what's coming next.

## Solution
- **Memory Crystal (base):** Persistent, structured, graph-enriched memory across sessions. Store, recall, search, checkpoint. Works with any LLM framework.
- **Organic Memory Crystal:** Prospective traces (future-oriented memory objects), background anticipation passes, memory ensembles, resonance/contradiction detection, prepared thought surfaces.
- **Organic Memory Graph (OMG):** Multidimensional memory engine tracking semantic, temporal, causal, agentic, counterfactual dimensions per memory node.

## Channels
- Open-source base layer (Memory Crystal) drives adoption
- GitHub, developer communities, AI agent Discord/Slack groups
- Content marketing (technical blog posts, benchmark comparisons)
- Framework integrations (OpenClaw plugin, LangChain, CrewAI)
- Academic paper / technical whitepaper for credibility
- X (Twitter) presence via @memorycrystal

## Revenue Streams
- **Free tier:** Self-hosted Memory Crystal (open source base)
- **Starter ($29/mo):** Managed Memory Crystal with cloud sync
- **Pro ($79/mo):** OMC features — prospective traces, anticipation, ensembles
- **Enterprise:** Custom deployment, SLA, dedicated support, OMG engine access
- Future: usage-based pricing for anticipation compute

## Key Metrics
- Developer signups / API key activations
- Memory operations per day (store, recall, anticipate)
- Anticipation hit rate (did the pre-assembled context get used?)
- Session continuity score (how well does the agent maintain context?)
- Benchmark performance (LoCoMo, LongMemEval, custom prospective benchmarks)

## Cost Structure
- Inference costs for anticipation passes (largest variable cost)
- Infrastructure (Convex backend, hosting, CDN)
- Engineering team
- Community management and developer relations

## Unfair Advantage
- First mover on prospective memory — nobody else is building the full anticipatory runtime
- Memory Crystal already in production with real users and an OpenClaw plugin ecosystem
- The OMG engine is a category-defining architecture, not an incremental feature
- "Organic Memory Graph" (OMG) as a brand is inherently memorable
- Deep understanding of agent memory from building and operating Memory Crystal in production

## Key Partners
- OpenClaw (distribution via plugin ecosystem)
- LLM providers (Anthropic, OpenAI, Google — for inference)
- Agent framework maintainers (LangChain, CrewAI, AutoGen)
- Academic researchers (benchmarking, validation)

## Existing Alternatives
- Mem0, Cognee, Zep, Letta — all retrospective memory
- Kumiho — has write-time prospective indexing but not runtime anticipation
- MemU — markets proactive memory but thin execution
- MemOS — infrastructure-level prefetching, not cognitive
- Custom RAG pipelines — fragile, no temporal/causal structure, no anticipation
