// ILL-108 — daily-driver UX. Three additive, opt-in ergonomics:
//   G2  L0 "core" tier — a small reserved set of identity/core memories that
//       crystal_wake always injects within its OWN bounded budget, independent
//       of query recall. Opt-in via the reserved `core` tag; none marked → no
//       change to wake output.
//   F1  future-recall questions — heuristic questions a checkpoint's window
//       uniquely answers, each linked to a memory id, persisted per checkpoint.
//   G3  overnight brief — a read-only 24h aggregation of what the background
//       engine did (consolidation/contradiction/idea activity), with a clean
//       "quiet" case.
//
// Pure helpers here are unit-tested directly; the internal queries are exercised
// through convex-test. Wiring lives in wake.ts (G2/G3) and checkpoints.ts (F1).

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── G2: L0 core tier ───────────────────────────────────────────────────────

/** Reserved tag marking an L0 "core" memory (identity / core rules). */
export const CORE_TAG = "core";
/** Hard cap on always-injected L0 memories — keeps the always-on budget tight. */
export const CORE_MEMORY_CAP = 8;

export function hasCoreTag(tags: unknown): boolean {
  return (
    Array.isArray(tags) &&
    tags.some((t) => String(t).trim().toLowerCase() === CORE_TAG)
  );
}

/** Pure: pick the strongest core-tagged memories up to the cap. */
export function selectCoreMemories<T extends { tags?: unknown; strength: number }>(
  memories: T[],
  cap: number = CORE_MEMORY_CAP,
): T[] {
  return memories
    .filter((m) => hasCoreTag(m.tags))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, Math.min(Math.max(1, cap), CORE_MEMORY_CAP));
}

/**
 * ILL-108 G2 — the L0 core set via exact indexed read. Seeks memories with
 * coreTier===true (set when the reserved `core` tag is added), archived===false,
 * strongest first. Cost O(core count), never scans the strength-ordered window.
 * User-global (identity applies on every channel). Opt-in: none marked → [].
 * Fail-open: returns empty on error so wake never breaks (wake.ts wraps this in
 * .catch(() => [])).
 */
export const getCoreMemories = internalQuery({
  args: { userId: v.string(), cap: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cap = Math.min(Math.max(1, args.cap ?? CORE_MEMORY_CAP), CORE_MEMORY_CAP);
    const cores = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_core", (q) =>
        q.eq("userId", args.userId).eq("coreTier", true).eq("archived", false),
      )
      .collect();
    // Sort by strength desc (index doesn't have strength as a sort key, so in-memory)
    const sorted = cores.sort((a, b) => b.strength - a.strength);
    return sorted.slice(0, cap).map((m: any) => ({
      memoryId: String(m._id),
      title: m.title,
      store: m.store,
      category: m.category,
      strength: m.strength,
    }));
  },
});

// ── F1: future-recall questions ─────────────────────────────────────────────

export type FutureRecallQuestion = { question: string; memoryId: string };

function questionForMemory(category: string, store: string, title: string): string {
  switch (category) {
    case "decision":
      return `What did we decide about ${title}?`;
    case "goal":
      return `What is the current status of the goal: ${title}?`;
    case "lesson":
      return `What did we learn about ${title}?`;
    case "rule":
      return `What is the rule regarding ${title}?`;
    case "workflow":
      return `How do we ${title}?`;
    case "person":
      return `What do we know about ${title}?`;
    case "event":
      return `What happened with ${title}?`;
    default:
      if (store === "prospective") return `What is the status of ${title}?`;
      return `What do we know about ${title}?`;
  }
}

/**
 * F1 — pure: turn a checkpoint's window memories into up to `max` future-recall
 * questions, each linked to the memory it uniquely answers. Deterministic (no
 * LLM — the checkpoint path is a mutation).
 */
export function buildFutureRecallQuestions(
  memories: Array<{ _id: unknown; store: string; category: string; title?: string }>,
  max = 5,
): FutureRecallQuestion[] {
  const out: FutureRecallQuestion[] = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    if (out.length >= max) break;
    const title = (memory.title ?? "").trim();
    if (!title) continue;
    const question = questionForMemory(memory.category, memory.store, title);
    if (seen.has(question)) continue;
    seen.add(question);
    out.push({ question, memoryId: String(memory._id) });
  }
  return out;
}

/** Deterministic per-checkpoint pulse id, so re-emission is idempotent. */
export function futureRecallPulseId(checkpointId: string): string {
  return `future-recall:${checkpointId}`;
}

/** Render the questions + their memory links into an organicIdea summary. */
export function renderFutureRecallSummary(questions: FutureRecallQuestion[]): string {
  return [
    "Questions this checkpoint's memories uniquely answer — ask these later to recall this window:",
    ...questions.map((q) => `- ${q.question} [memory: ${q.memoryId}]`),
  ].join("\n");
}

const FUTURE_RECALL_IDEA_TYPE = "insight" as const;
const FUTURE_RECALL_TITLE = "Future-recall questions";

/**
 * F1 — emit the future-recall questions for a checkpoint as a single organicIdea,
 * idempotent per checkpoint (deduped by pulseId). Called inline from the
 * checkpoint mutation (both dashboard + MCP paths bottom out here); heuristic,
 * no LLM. Returns the questions so the checkpoint response can carry them.
 * Plain ctx helper (not a registered mutation) so it composes inside the
 * checkpoint transaction.
 */
export async function emitFutureRecallQuestionsForCheckpoint(
  ctx: any,
  args: {
    userId: string;
    checkpointId: string;
    memories: Array<{ _id: unknown; store: string; category: string; title?: string }>;
    max?: number;
  },
): Promise<{ questions: FutureRecallQuestion[]; emitted: boolean }> {
  const questions = buildFutureRecallQuestions(args.memories, args.max ?? 5);
  if (questions.length === 0) return { questions, emitted: false };

  const pulseId = futureRecallPulseId(args.checkpointId);
  // Dedupe by RECENCY, not the status-ordered by_user_type index: a re-run of
  // the same checkpoint happens close in time, so the original idea is among the
  // newest. This holds regardless of how many "insight" ideas the user has
  // accumulated (F1/G3/organic all share that type).
  const recent = await ctx.db
    .query("organicIdeas")
    .withIndex("by_user_created", (q: any) => q.eq("userId", args.userId))
    .order("desc")
    .take(200);
  if (recent.some((idea: any) => idea.pulseId === pulseId)) {
    return { questions, emitted: false };
  }

  const sourceMemoryIds = Array.from(
    new Set(questions.map((question) => question.memoryId)),
  );
  const now = Date.now();
  await ctx.db.insert("organicIdeas", {
    userId: args.userId,
    title: FUTURE_RECALL_TITLE,
    summary: renderFutureRecallSummary(questions),
    ideaType: FUTURE_RECALL_IDEA_TYPE,
    sourceMemoryIds,
    confidence: 0.5,
    status: "pending_notification" as const,
    pulseId,
    createdAt: now,
    updatedAt: now,
  });
  return { questions, emitted: true };
}

// ── G3: overnight brief ──────────────────────────────────────────────────────

const OVERNIGHT_BRIEF_PULSE_PREFIX = "overnight-brief:";
const NOTABLE_IDEA_LIMIT = 5;
const IDEA_PAGE_SIZE = 20;
const IDEA_MAX_PAGES = 5;

/** Derived overnight briefs are notifications, not source activity for another brief. */
export function isOvernightBriefIdea(idea: { pulseId?: string }): boolean {
  return idea.pulseId?.startsWith(OVERNIGHT_BRIEF_PULSE_PREFIX) ?? false;
}

/** Pure: select recent source ideas while excluding generated overnight briefs. */
export function selectNotableIdeas<T extends { pulseId?: string }>(
  ideas: T[],
  cap = NOTABLE_IDEA_LIMIT,
): T[] {
  return ideas.filter((idea) => !isOvernightBriefIdea(idea)).slice(0, cap);
}

/**
 * G3 — read-only 24h aggregation of background-engine activity from existing
 * logs (organicTickRuns) plus new ideas (organicIdeas). Bounded indexed seeks.
 * `quiet` is true when nothing of note happened, so callers render "no changes"
 * without a special case.
 */
export const getOvernightBrief = internalQuery({
  args: {
    userId: v.string(),
    sinceMs: v.optional(v.number()),
    nowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.nowMs ?? Date.now();
    const since = args.sinceMs ?? now - DAY_MS;

    const ticks = await ctx.db
      .query("organicTickRuns")
      .withIndex("by_user_started", (q) =>
        q.eq("userId", args.userId).gte("startedAt", since),
      )
      .take(500);

    let contradictionsFound = 0;
    let ensemblesCreated = 0;
    let ideasCreated = 0;
    let tracesGenerated = 0;
    for (const tick of ticks) {
      contradictionsFound += tick.contradictionsFound ?? 0;
      ensemblesCreated += tick.ensemblesCreated ?? 0;
      ideasCreated += tick.ideasCreated ?? 0;
      tracesGenerated += tick.tracesGenerated ?? 0;
    }

    // Consolidation / promotion activity lives in reflection runs (consolidate.ts
    // itself writes no event row — it inserts promoted memories and returns
    // in-memory stats, which the reflection run records).
    const reflections = await ctx.db
      .query("crystalReflectionRuns")
      .withIndex("by_user_started", (q) =>
        q.eq("userId", args.userId).gte("startedAt", since),
      )
      .take(500);
    let promoted = 0;
    let consolidated = 0;
    let archived = 0;
    for (const run of reflections) {
      promoted += run.promoted ?? 0;
      consolidated += run.summarized ?? 0;
      archived += run.archived ?? 0;
    }

    const sourceIdeas: Array<{
      _id: unknown;
      title: string;
      ideaType: string;
      pulseId?: string;
    }> = [];
    let ideaCursor: string | null = null;
    for (
      let pageNumber = 0;
      pageNumber < IDEA_MAX_PAGES && sourceIdeas.length < NOTABLE_IDEA_LIMIT;
      pageNumber += 1
    ) {
      const page = await ctx.db
        .query("organicIdeas")
        .withIndex("by_user_created", (q) =>
          q.eq("userId", args.userId).gte("createdAt", since),
        )
        .order("desc")
        .paginate({ cursor: ideaCursor, numItems: IDEA_PAGE_SIZE });
      sourceIdeas.push(
        ...selectNotableIdeas(
          page.page,
          NOTABLE_IDEA_LIMIT - sourceIdeas.length,
        ),
      );
      if (page.isDone) break;
      ideaCursor = page.continueCursor;
    }
    const notableIdeas = sourceIdeas.map((idea) => ({
      id: String(idea._id),
      title: idea.title,
      ideaType: idea.ideaType,
    }));

    const counts = {
      ticks: ticks.length,
      reflectionRuns: reflections.length,
      contradictionsFound,
      ensemblesCreated,
      ideasCreated,
      tracesGenerated,
      promoted,
      consolidated,
      archived,
    };
    const quiet =
      contradictionsFound === 0 &&
      ensemblesCreated === 0 &&
      ideasCreated === 0 &&
      promoted === 0 &&
      consolidated === 0 &&
      archived === 0 &&
      notableIdeas.length === 0;

    return { windowStartMs: since, computedAt: now, quiet, counts, notableIdeas };
  },
});

const OVERNIGHT_BRIEF_TITLE = "Overnight brief";
const OVERNIGHT_BRIEF_IDEA_TYPE = "insight" as const;

function overnightDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

function renderOvernightSummary(counts: {
  contradictionsFound: number;
  ensemblesCreated: number;
  ideasCreated: number;
  promoted: number;
  consolidated: number;
  archived: number;
}): string {
  return (
    `Overnight, your memory maintained itself: ` +
    `${counts.consolidated} consolidated, ${counts.promoted} promoted, ` +
    `${counts.contradictionsFound} contradiction(s) found, ` +
    `${counts.ensemblesCreated} ensemble(s) formed, ${counts.ideasCreated} new idea(s).`
  );
}

/**
 * Emit one overnight-brief idea per user per day, idempotently (deduped by a
 * per-day pulseId). Skips when the window was quiet.
 */
export const emitOvernightBriefIdea = internalMutation({
  args: {
    userId: v.string(),
    summary: v.string(),
    dateKey: v.string(),
  },
  handler: async (ctx, args) => {
    const pulseId = `${OVERNIGHT_BRIEF_PULSE_PREFIX}${args.dateKey}`;
    // Dedupe by RECENCY (by_user_created desc): a same-day re-fire on redeploy
    // finds today's brief among the newest ideas, regardless of total
    // "insight"-typed idea volume.
    const recent = await ctx.db
      .query("organicIdeas")
      .withIndex("by_user_created", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(200);
    if (recent.some((idea) => idea.pulseId === pulseId)) {
      return { emitted: false };
    }
    const now = Date.now();
    await ctx.db.insert("organicIdeas", {
      userId: args.userId,
      title: OVERNIGHT_BRIEF_TITLE,
      summary: args.summary,
      ideaType: OVERNIGHT_BRIEF_IDEA_TYPE,
      sourceMemoryIds: [],
      confidence: 0.5,
      status: "pending_notification" as const,
      pulseId,
      createdAt: now,
      updatedAt: now,
    });
    return { emitted: true };
  },
});

const USER_PAGE_SIZE = 100;

/**
 * G3 daily cron — all-users overnight brief. Pages user profiles, aggregates the
 * prior 24h of background activity, and emits one brief idea per active user
 * (skips quiet accounts). A dedicated cron rather than a per-wake recompute, so
 * neither wake path pays for it and it runs once per day.
 */
export const emitOvernightBriefForAllUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const dateKey = overnightDateKey(now);
    let cursor: string | undefined = undefined;
    let usersScanned = 0;
    let briefsEmitted = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const page: any = await ctx.runQuery(
        internal.crystal.userProfiles.listUserIdsPage,
        { cursor, numItems: USER_PAGE_SIZE },
      );
      for (const userId of page.userIds) {
        usersScanned += 1;
        const brief: any = await ctx.runQuery(
          internal.crystal.dailyDriver.getOvernightBrief,
          { userId, nowMs: now },
        );
        if (brief.quiet) continue;
        const out: any = await ctx.runMutation(
          internal.crystal.dailyDriver.emitOvernightBriefIdea,
          { userId, summary: renderOvernightSummary(brief.counts), dateKey },
        );
        if (out.emitted) briefsEmitted += 1;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return { usersScanned, briefsEmitted };
  },
});
