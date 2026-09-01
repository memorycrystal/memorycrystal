// ILL-107 — hygiene worklists. Turns MC's stat COUNTERS into actionable
// worklists of specific memory IDs, plus two graph/gap lints. All three are
// strictly read-only/advisory (hygiene surfaces; the user/skill decides) and
// cost-bounded at 33k scale.
//
//   D2 getStaleWorklist  — the stalest memories, bucketed (stale30/60/90 +
//                          neverRecalled), with triage context. One bounded
//                          indexed seek (oldest-first), no full scan.
//   C1 lintMemoryGraph   — cycles (mutual supersession), dangling edges, and
//                          missing inverses over supersession + associations.
//   D3 scanConceptGaps   — recurring tags/entities with no canonical memory →
//                          one idempotent organicIdea.
//
// The counters these reconcile with live in evalStats.ts and are a SCALED
// SAMPLE estimate at large N; the worklist below returns EXACT IDs from the
// bounded page, so exact equality with the cache holds only when the cache scan
// was complete (small accounts / tests). See getStaleWorklist doc.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const DAY_MS = 24 * 60 * 60 * 1000;

// Default page cap for the worklist seek. Bounds cost at 33k scale: we read at
// most this many of the stalest rows per call, never the whole table.
const DEFAULT_WORKLIST_LIMIT = 200;
const MAX_WORKLIST_LIMIT = 500;

type WorklistRow = {
  id: string;
  title: string;
  store: string;
  ageDays: number;
  idleDays: number;
  lastAccessedAt: number;
  strength: number;
  accessCount: number;
};

function toRow(memory: any, now: number): WorklistRow {
  return {
    id: String(memory._id),
    title: memory.title,
    store: memory.store,
    ageDays: Math.floor((now - memory.createdAt) / DAY_MS),
    idleDays: Math.floor((now - memory.lastAccessedAt) / DAY_MS),
    lastAccessedAt: memory.lastAccessedAt,
    strength: memory.strength,
    accessCount: memory.accessCount ?? 0,
  };
}

/**
 * D2 — stale/never-recalled worklist.
 *
 * Seeks `by_user_archived_last_accessed` for rows idle >= 30d, oldest-first (the
 * stalest, highest-priority rows) for a single bounded page, then buckets in
 * memory:
 *   stale30/60/90 — lastAccessedAt older than 30/60/90 days (matches
 *     evalStats' predicate: `lastAccessedAt <= cutoff`, archived === false).
 *   neverRecalled — accessCount === 0 among the stale page, i.e. stale AND
 *     never-recalled — precisely the actionable hygiene set AC-1 pairs. A
 *     freshly-created never-recalled memory (<30d idle) is not a hygiene
 *     concern and is intentionally not surfaced.
 *
 * Returns specific IDs per bucket with triage context. Bounded and indexed:
 * O(limit) reads, never O(all). `pageTruncated` signals more stale rows exist
 * beyond the page (paginate via a larger limit or a follow-up cursor tool).
 *
 * Reconciliation: for accounts small enough that the stats cache scanned every
 * row (scale === 1), these exact bucket counts equal the cache counters. At
 * large N the cache is a scaled sample, so counts reconcile within sampling
 * error, not exactly — by design.
 */
export const getStaleWorklist = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(
      Math.max(1, args.limit ?? DEFAULT_WORKLIST_LIMIT),
      MAX_WORKLIST_LIMIT,
    );
    const stale30Cutoff = now - 30 * DAY_MS;
    const stale60Cutoff = now - 60 * DAY_MS;
    const stale90Cutoff = now - 90 * DAY_MS;

    // Seek only rows idle >= 30d (lastAccessedAt <= stale30Cutoff), oldest-first
    // — the exact stale set, stalest rows first, so a bounded page is the
    // highest-priority worklist and we never read fresh rows. `+ 1` detects
    // truncation. The stale counters in crystalStatsCache are written as 0 by
    // the routine cron (only a legacy full-rebuild populated them), so this
    // computes stale exactly on-read rather than trusting the cache.
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_last_accessed", (q) =>
        q
          .eq("userId", args.userId)
          .eq("archived", false)
          .lte("lastAccessedAt", stale30Cutoff),
      )
      .order("asc")
      .take(limit + 1);

    const pageTruncated = page.length > limit;
    const rows = page.slice(0, limit);

    const stale30: WorklistRow[] = [];
    const stale60: WorklistRow[] = [];
    const stale90: WorklistRow[] = [];
    const neverRecalled: WorklistRow[] = [];

    for (const memory of rows) {
      const row = toRow(memory, now);
      // Buckets are cumulative-exclusive so a row lands in exactly one staleness
      // band (>=90 wins over >=60 wins over >=30), matching how a triager reads
      // them; the cache counters are cumulative, reconciled in `counts` below.
      if (memory.lastAccessedAt <= stale90Cutoff) stale90.push(row);
      else if (memory.lastAccessedAt <= stale60Cutoff) stale60.push(row);
      else if (memory.lastAccessedAt <= stale30Cutoff) stale30.push(row);
      if ((memory.accessCount ?? 0) === 0) neverRecalled.push(row);
    }

    return {
      userId: args.userId,
      computedAt: now,
      limit,
      pageTruncated,
      buckets: { stale30, stale60, stale90, neverRecalled },
      // Cumulative counts, matching evalStats' staleCountNNd semantics
      // (a >=90d row is also counted in 60d and 30d).
      counts: {
        stale30: stale30.length + stale60.length + stale90.length,
        stale60: stale60.length + stale90.length,
        stale90: stale90.length,
        neverRecalled: neverRecalled.length,
        scanned: rows.length,
      },
    };
  },
});

const DEFAULT_LINT_LIMIT = 500;
const MAX_LINT_LIMIT = 2000;

type GraphFinding = {
  type:
    | "association_cycle"
    | "association_dangling"
    | "association_self_loop"
    | "supersession_cycle"
    | "supersession_dangling"
    | "supersession_missing_inverse";
  severity: "warn" | "error";
  memoryIds: string[];
  detail: string;
};

/** Stable unordered key for a memory pair, so a cycle is reported once. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * C1 — graph lint. Read-only, bounded, per-user. Detects, over a bounded page:
 *   - association cycles (mutual A⇄B of the same relationshipType, e.g. an
 *     unresolved contradiction pointing both ways), dangling edges (endpoint
 *     memory deleted), and self-loops (from === to);
 *   - supersession cycles (A.supersededBy === B and B.supersededBy === A),
 *     dangling supersession targets, and missing inverse links
 *     (A.supersededBy === B but B.supersedes !== A).
 * Emits findings only; never auto-fixes (AC-5). A clean graph returns none.
 */
export const lintMemoryGraph = internalQuery({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(1, args.limit ?? DEFAULT_LINT_LIMIT),
      MAX_LINT_LIMIT,
    );
    const findings: GraphFinding[] = [];

    // --- Associations: cycles, dangling, self-loops -----------------------
    const associations = await ctx.db
      .query("crystalAssociations")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(limit);

    const edgeSet = new Set<string>();
    for (const edge of associations) {
      edgeSet.add(`${edge.fromMemoryId}->${edge.toMemoryId}:${edge.relationshipType}`);
    }
    const reportedCycles = new Set<string>();
    const memoryExistsCache = new Map<string, boolean>();
    const exists = async (id: string): Promise<boolean> => {
      if (memoryExistsCache.has(id)) return memoryExistsCache.get(id)!;
      const doc = await ctx.db.get(id as any);
      const ok = doc !== null;
      memoryExistsCache.set(id, ok);
      return ok;
    };

    for (const edge of associations) {
      const from = String(edge.fromMemoryId);
      const to = String(edge.toMemoryId);
      if (from === to) {
        findings.push({
          type: "association_self_loop",
          severity: "warn",
          memoryIds: [from],
          detail: `${edge.relationshipType} edge points a memory at itself`,
        });
        continue;
      }
      if (!(await exists(from)) || !(await exists(to))) {
        findings.push({
          type: "association_dangling",
          severity: "error",
          memoryIds: [from, to],
          detail: `${edge.relationshipType} edge references a missing memory`,
        });
        continue;
      }
      const reverse = `${to}->${from}:${edge.relationshipType}`;
      if (edgeSet.has(reverse)) {
        const key = pairKey(from, to);
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          findings.push({
            type: "association_cycle",
            severity: "warn",
            memoryIds: [from, to],
            detail: `mutual ${edge.relationshipType} edges (A⇄B)`,
          });
        }
      }
    }

    // --- Supersession: cycles, dangling, missing inverse ------------------
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(limit);

    const reportedSupCycles = new Set<string>();
    for (const memory of memories) {
      const supBy = memory.supersededByMemoryId;
      if (!supBy) continue;
      const self = String(memory._id);
      const target = await ctx.db.get(supBy as any);
      if (!target) {
        findings.push({
          type: "supersession_dangling",
          severity: "error",
          memoryIds: [self, String(supBy)],
          detail: "supersededByMemoryId points at a missing memory",
        });
        continue;
      }
      if (String((target as any).supersededByMemoryId ?? "") === self) {
        const key = pairKey(self, String(supBy));
        if (!reportedSupCycles.has(key)) {
          reportedSupCycles.add(key);
          findings.push({
            type: "supersession_cycle",
            severity: "error",
            memoryIds: [self, String(supBy)],
            detail: "A supersedes B and B supersedes A",
          });
        }
        continue;
      }
      if (String((target as any).supersedesMemoryId ?? "") !== self) {
        findings.push({
          type: "supersession_missing_inverse",
          severity: "warn",
          memoryIds: [self, String(supBy)],
          detail: "supersededBy set but the target's supersedes link is missing",
        });
      }
    }

    return {
      userId: args.userId,
      computedAt: Date.now(),
      limit,
      scanned: { associations: associations.length, memories: memories.length },
      // A full page may mean more edges/rows exist beyond the cap — surface it
      // rather than silently reporting a partial lint as complete.
      truncated: {
        associations: associations.length >= limit,
        memories: memories.length >= limit,
      },
      findingCount: findings.length,
      findings,
    };
  },
});

const CONCEPT_GAP_MIN_FREQUENCY = 3;
// The ideaType validator (organic/ideas.ts) accepts "pattern" but NOT
// "skill_suggestion" — a recurring term lacking a canonical memory is a pattern.
const CONCEPT_GAP_IDEA_TYPE = "pattern" as const;
const CONCEPT_GAP_TITLE_PREFIX = "Concept gap:";
const DEFAULT_CONCEPT_SCAN_LIMIT = 500;
const MAX_CONCEPT_SCAN_LIMIT = 2000;
const CONCEPT_GAP_MAX_EMIT = 10; // don't storm the ideas feed in a single run
const CONCEPT_GAP_SOURCE_CAP = 10; // sample of source memories per idea

/**
 * D3 — concept-gap scan. Over a bounded page of a user's active memories, tally
 * tag frequency and detect terms appearing in >= 3 memories with no canonical
 * `semantic` memory of their own (no semantic memory whose title is the term).
 * Each gap emits ONE `organicIdea` (type "pattern") suggesting a canonical
 * memory. Idempotent: a deterministic `Concept gap: <term>` title is checked
 * against existing ideas first, so re-running does not duplicate (AC-3).
 * Advisory only — never archives/deletes a memory.
 */
export const scanConceptGaps = internalMutation({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
    pulseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(
      Math.max(1, args.limit ?? DEFAULT_CONCEPT_SCAN_LIMIT),
      MAX_CONCEPT_SCAN_LIMIT,
    );

    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .take(limit);

    const tagFreq = new Map<string, { count: number; sources: any[] }>();
    const canonicalTerms = new Set<string>(); // terms that already have a home
    for (const memory of memories) {
      if (memory.store === "semantic" && typeof memory.title === "string") {
        canonicalTerms.add(memory.title.trim().toLowerCase());
      }
      for (const raw of memory.tags ?? []) {
        const term = String(raw).trim().toLowerCase();
        if (!term) continue;
        const entry = tagFreq.get(term) ?? { count: 0, sources: [] };
        entry.count += 1;
        if (entry.sources.length < CONCEPT_GAP_SOURCE_CAP) entry.sources.push(memory._id);
        tagFreq.set(term, entry);
      }
    }

    const candidates = [...tagFreq.entries()]
      .filter(
        ([term, entry]) =>
          entry.count >= CONCEPT_GAP_MIN_FREQUENCY && !canonicalTerms.has(term),
      )
      .sort((a, b) => b[1].count - a[1].count);

    // Idempotency guard: existing concept-gap ideas for this user (any status),
    // keyed by the deterministic title.
    const existingIdeas = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_type", (q) =>
        q.eq("userId", args.userId).eq("ideaType", CONCEPT_GAP_IDEA_TYPE),
      )
      .take(500);
    const coveredTitles = new Set(
      existingIdeas
        .filter(
          (idea) =>
            typeof idea.title === "string" &&
            idea.title.startsWith(CONCEPT_GAP_TITLE_PREFIX),
        )
        .map((idea) => idea.title),
    );

    const pulseId = args.pulseId ?? `concept-gap:${now}`;
    const emitted: { term: string; ideaId: string; frequency: number }[] = [];
    for (const [term, entry] of candidates) {
      if (emitted.length >= CONCEPT_GAP_MAX_EMIT) break;
      const title = `${CONCEPT_GAP_TITLE_PREFIX} ${term}`;
      if (coveredTitles.has(title)) continue;
      const ideaId = await ctx.db.insert("organicIdeas", {
        userId: args.userId,
        title,
        summary:
          `The term "${term}" appears in ${entry.count} memories but has no ` +
          `canonical semantic memory. Consider creating one to anchor recall.`,
        ideaType: CONCEPT_GAP_IDEA_TYPE,
        sourceMemoryIds: entry.sources,
        confidence: 0.5,
        status: "pending_notification" as const,
        pulseId,
        createdAt: now,
        updatedAt: now,
      });
      coveredTitles.add(title);
      emitted.push({ term, ideaId: String(ideaId), frequency: entry.count });
    }

    return {
      userId: args.userId,
      scanned: memories.length,
      candidateCount: candidates.length,
      emittedCount: emitted.length,
      emitted,
    };
  },
});

const GRAPH_HYGIENE_TITLE = "Graph hygiene worklist";
const GRAPH_HYGIENE_IDEA_TYPE = "action_suggested" as const;

/**
 * Emit a single graph-hygiene idea when C1 found issues, idempotently: skips if
 * a pending graph-hygiene idea already exists for the user (one open at a time).
 */
export const emitGraphHygieneIdea = internalMutation({
  args: {
    userId: v.string(),
    findingCount: v.number(),
    findingTypes: v.array(v.string()),
    pulseId: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.findingCount <= 0) return { emitted: false };
    const pending = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_type", (q) =>
        q
          .eq("userId", args.userId)
          .eq("ideaType", GRAPH_HYGIENE_IDEA_TYPE)
          .eq("status", "pending_notification"),
      )
      .take(50);
    if (pending.some((idea) => idea.title === GRAPH_HYGIENE_TITLE)) {
      return { emitted: false };
    }
    const now = Date.now();
    await ctx.db.insert("organicIdeas", {
      userId: args.userId,
      title: GRAPH_HYGIENE_TITLE,
      summary:
        `The graph lint found ${args.findingCount} hygiene issue(s) ` +
        `(${[...new Set(args.findingTypes)].join(", ")}). ` +
        `Run crystal-hygiene to review cycles, dangling edges, and missing inverses.`,
      ideaType: GRAPH_HYGIENE_IDEA_TYPE,
      sourceMemoryIds: [],
      confidence: 0.6,
      status: "pending_notification" as const,
      pulseId: args.pulseId,
      createdAt: now,
      updatedAt: now,
    });
    return { emitted: true };
  },
});

const USER_PAGE_SIZE = 100;

/**
 * C1 cron — low-frequency, all-users. Pages through user profiles, lints each
 * user's graph, and emits a graph-hygiene idea (deduped) when findings exist.
 * Read-only w.r.t. memories; advisory only.
 */
export const runGraphLintForAllUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    const pulseId = `graph-lint:${Date.now()}`;
    let cursor: string | undefined = undefined;
    let usersLinted = 0;
    let usersWithFindings = 0;
    let ideasEmitted = 0;
    // Bounded per page; loops until the profile table is exhausted.
    for (let guard = 0; guard < 10_000; guard++) {
      const page: any = await ctx.runQuery(
        internal.crystal.userProfiles.listUserIdsPage,
        { cursor, numItems: USER_PAGE_SIZE },
      );
      for (const userId of page.userIds) {
        const res: any = await ctx.runQuery(
          internal.crystal.hygieneWorklist.lintMemoryGraph,
          { userId },
        );
        usersLinted += 1;
        if (res.findingCount > 0) {
          usersWithFindings += 1;
          const out: any = await ctx.runMutation(
            internal.crystal.hygieneWorklist.emitGraphHygieneIdea,
            {
              userId,
              findingCount: res.findingCount,
              findingTypes: res.findings.map((f: any) => f.type),
              pulseId,
            },
          );
          if (out.emitted) ideasEmitted += 1;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return { usersLinted, usersWithFindings, ideasEmitted };
  },
});

/**
 * D3 cron — periodic, all-users. Pages through user profiles and runs the
 * concept-gap scan for each (itself idempotent).
 */
export const runConceptGapScanForAllUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | undefined = undefined;
    let usersScanned = 0;
    let totalEmitted = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const page: any = await ctx.runQuery(
        internal.crystal.userProfiles.listUserIdsPage,
        { cursor, numItems: USER_PAGE_SIZE },
      );
      for (const userId of page.userIds) {
        const res: any = await ctx.runMutation(
          internal.crystal.hygieneWorklist.scanConceptGaps,
          { userId },
        );
        usersScanned += 1;
        totalEmitted += res.emittedCount;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return { usersScanned, totalEmitted };
  },
});
