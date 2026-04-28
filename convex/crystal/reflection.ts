import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { type Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getMemoryEffectiveText } from "./memoryText";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_HOURS = 4;

const GEMINI_EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";

async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  const model = process.env.GEMINI_EMBEDDING_MODEL || GEMINI_EMBEDDING_MODEL;
  const response = await fetch(
    `${GEMINI_EMBEDDING_ENDPOINT}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    }
  );
  const payload = await response.json().catch(() => null);
  const vector = payload?.embedding?.values;
  if (!response.ok || !Array.isArray(vector)) {
    console.log(`[reflection.embedText] Gemini embedding failed: status=${response.status}`);
    return [];
  }
  return vector as number[];
}
const MAX_MEMORIES_FOR_REFLECTION = 30;
const MIN_MEMORIES_FOR_REFLECTION = 3;
const OPENAI_COMPLETIONS_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const REFLECTION_MODEL = "gpt-4o-mini";
const REFLECTION_TEMPERATURE = 0.3;

// ── Types ─────────────────────────────────────────────────────────────────────

type MemoryInput = {
  id: string;
  store: string;
  title: string;
  content: string;
  tags: string[];
};

type ReflectionResult = {
  memorySummaries?: Array<{ index: number; summary: string }>;
  decisions: string[];
  lessons: string[];
  summary: string;
  openLoops: string[];
  tags: string[];
};

type ReflectionStats = {
  memoriesRead: number;
  decisionsWritten: number;
  lessonsWritten: number;
  summaryWritten: boolean;
  openLoopsWritten: number;
  summary: string;
  skipped?: string;
};

type LowSalienceReviewResult = {
  promoted: number;
  decayed: number;
};

// ── Prompt builder ─────────────────────────────────────────────────────────────

const buildReflectionPrompt = (memories: MemoryInput[]): string => {
  const memoryContext = memories
    .map((m, i) => `${i}. [${m.store}] ${m.title}\n${m.content.slice(0, 300)}`)
    .join("\n\n");

  return `You are a memory distillation assistant. Analyze these recent AI agent memories and extract structured insights.

MEMORIES:
${memoryContext}

Respond with ONLY valid JSON (no markdown, no code blocks) in this exact format:
{
  "memorySummaries": [{"index": 0, "summary": "brief retained summary for this source memory"}],
  "decisions": ["decision made 1", "decision made 2"],
  "lessons": ["lesson or pattern learned 1", "lesson or pattern learned 2"],
  "summary": "2-3 sentence summary of what was worked on in this session",
  "openLoops": ["unresolved question or pending task 1"],
  "tags": ["relevant", "topic", "tags"]
}

Rules:
- memorySummaries: one concise 1-sentence retained summary for source memories worth preserving; use the zero-based list indexes exactly as shown
- decisions: concrete choices or commitments made (e.g., "Decided to use Convex for persistence")
- lessons: reusable insights, patterns, or things to remember (e.g., "Rate limiting must be per-user not global")
- summary: what was actually worked on, 2-3 sentences, past tense
- openLoops: tasks started but not finished, questions unanswered, todos
- tags: 3-8 concise topic tags, lowercase, no spaces
- Omit any category if it has 0 entries (use empty array [])
- Keep each item to 1-2 sentences max`;
};

const buildLowSalienceReviewPrompt = (memories: {
  title: string;
  content: string;
}[]): string => {
  const memoryContext = memories
    .map((memory, index) => `${index}. ${memory.title}\n${memory.content.slice(0, 200)}`)
    .join("\n\n");

  return `You are a memory curator. Review these low-salience sensory memories and decide which (if any) deserve promotion to episodic memory for longer retention.\n\nMemories:\n${memoryContext}\n\nFor each memory, respond with ONLY valid JSON:\n{\n  "promote": [\n    { "index": 0, "reason": "contains important decision", "newSalienceScore": 0.72 }\n  ],\n  "decay": [0, 1, 2]\n}\n\n\"promote\" = indexes to upgrade to episodic store with updated salience\n\"decay\" = indexes that are pure noise and can be archived\nOnly promote if genuinely valuable. When in doubt, leave it as-is (return empty arrays).`;
};

// ── Internal query: fetch recent sensory + episodic memories ──────────────────

export const getRecentMemoriesForReflection = internalQuery({
  args: {
    userId: v.string(),
    windowMs: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.windowMs;

    // Fetch a larger buffer from the index, then filter by time + store
    const candidates = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .order("desc")
      .take(Math.min(args.limit * 4, 200));

    return candidates
      .filter(
        (m) =>
          m.createdAt >= cutoff &&
          (m.store === "sensory" || m.store === "episodic")
      )
      .slice(0, args.limit);
  },
});

export const patchSourceMemorySummary = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    summary: v.string(),
    summarySource: v.union(
      v.literal("baseline_reflection"),
      v.literal("organic_pulse"),
      v.literal("backfill"),
      v.literal("manual"),
      v.literal("imported")
    ),
    summaryModel: v.optional(v.string()),
    summaryCostUsd: v.optional(v.float64()),
    reflectionRunId: v.optional(v.id("crystalReflectionRuns")),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory || memory.archived || memory.knowledgeBaseId) return null;
    const summary = args.summary.trim();
    if (!summary) return null;
    await ctx.db.patch(args.memoryId, {
      summary,
      recallText: summary,
      summaryCreatedAt: Date.now(),
      summarySource: args.summarySource,
      summaryModel: args.summaryModel,
      summaryCostUsd: args.summaryCostUsd,
      rawRetentionState: memory.rawContentWipedAt ? "wiped" : "summarized",
      reflectionRunId: args.reflectionRunId,
    });
    return { ok: true };
  },
});

// ── Low-salience LLM review for sensory archival/promotions ────────────────

export const reviewLowSalienceMemories = internalAction({
  args: {
    userId: v.string(),
    windowHours: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LowSalienceReviewResult> => {
    const windowHours = Math.min(Math.max(args.windowHours ?? DEFAULT_WINDOW_HOURS, 0.5), 72);
    const windowMs = windowHours * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.log(`[reviewLowSalienceMemories] user ${args.userId}: OPENAI_API_KEY not set`);
      return { promoted: 0, decayed: 0 };
    }

    const lowSalienceMemories = (
      (await ctx.runQuery(internal.crystal.salience.getLowSalienceMemoriesForPromotion, {
        userId: args.userId,
        store: "sensory",
        limit: 50,
        maxSalienceScore: 0.45,
      })) as Array<{
        _id: string;
        title: string;
        content: string;
        createdAt: number;
        strength: number;
        salienceScore?: number;
      }>
    ).filter((memory) => memory.createdAt >= cutoff);

    if (lowSalienceMemories.length === 0) {
      return { promoted: 0, decayed: 0 };
    }

    const prompt = buildLowSalienceReviewPrompt(
      lowSalienceMemories.map((memory) => ({
        title: memory.title,
        content: memory.content,
      }))
    );

    let responsePayload: unknown;

    try {
      const response = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: REFLECTION_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: OpenAI API error ${response.status}: ${errorText}`);
        return { promoted: 0, decayed: 0 };
      }

      const payload = (await response.json()) as any;
      const rawContent = payload?.choices?.[0]?.message?.content ?? "";
      if (!rawContent?.trim()) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: Empty model response`);
        return { promoted: 0, decayed: 0 };
      }

      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      responsePayload = JSON.parse(cleaned) as unknown;
    } catch (err) {
      console.log(`[reviewLowSalienceMemories] user ${args.userId}: Failed to call or parse OpenAI response`, err);
      return { promoted: 0, decayed: 0 };
    }

    const rawPromote = Array.isArray((responsePayload as any)?.promote) ? (responsePayload as any).promote : [];
    const rawDecay = Array.isArray((responsePayload as any)?.decay) ? (responsePayload as any).decay : [];

    let promoted = 0;
    let decayed = 0;

    const usedPromote = new Set<number>();
    const usedDecay = new Set<number>();

    const now = Date.now();

    for (const raw of rawDecay) {
      const index = Number((raw as any)?.index);
      if (!Number.isInteger(index) || index < 0 || index >= lowSalienceMemories.length) continue;
      if (usedPromote.has(index)) continue;
      usedDecay.add(index);

      const memory = lowSalienceMemories[index];
      try {
        await ctx.runMutation(internal.crystal.salience.decayLowSalienceMemory, {
          userId: args.userId,
          memoryId: memory._id as Id<"crystalMemories">,
          archivedAt: now,
        });
        decayed += 1;
      } catch (err) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: failed decay memory ${memory._id}`, err);
      }
    }

    for (const raw of rawPromote) {
      const index = Number((raw as any)?.index);
      if (!Number.isInteger(index) || index < 0 || index >= lowSalienceMemories.length) continue;
      if (usedDecay.has(index)) continue;
      usedPromote.add(index);

      const memory = lowSalienceMemories[index];
      const newSalienceScore = Number((raw as any)?.newSalienceScore);
      const sanitizedSalience = Number.isFinite(newSalienceScore)
        ? clampScore(newSalienceScore)
        : clampScore(memory.salienceScore ?? 0.45);
      const boostedStrength = clampScore((memory.strength ?? 0.8) + 0.1);

      try {
        await ctx.runMutation(internal.crystal.salience.promoteLowSalienceMemory, {
          userId: args.userId,
          memoryId: memory._id as Id<"crystalMemories">,
          salienceScore: sanitizedSalience,
          strength: boostedStrength,
        });
        promoted += 1;
      } catch (err) {
        console.log(`[reviewLowSalienceMemories] user ${args.userId}: failed promote memory ${memory._id}`, err);
      }
    }

    return { promoted, decayed };
  },
});

const clampScore = (value: number) => Math.min(Math.max(value, 0), 1);

// ── Core internal action ───────────────────────────────────────────────────────

export const runReflectionForUser = internalAction({
  args: {
    userId: v.string(),
    sessionId: v.optional(v.id("crystalSessions")),
    windowHours: v.optional(v.number()),
    openaiApiKey: v.string(),
  },
  handler: async (ctx, args): Promise<ReflectionStats> => {
    const windowHours = Math.min(Math.max(args.windowHours ?? DEFAULT_WINDOW_HOURS, 0.5), 72);
    const windowMs = windowHours * 60 * 60 * 1000;
    const tierInfo = await ctx.runQuery((internal as any).crystal.userProfiles.getUserTierInfo, {
      userId: args.userId,
    }).catch(() => ({ tier: "free", sensoryRawTtlDays: 7 }));
    let reflectionRunId: Id<"crystalReflectionRuns"> | undefined;
    try {
      reflectionRunId = await ctx.runMutation((internal as any).crystal.reflectionLog.createRun, {
        userId: args.userId,
        trigger: "cron",
        tier: tierInfo.tier,
        sensoryRawTtlDays: tierInfo.sensoryRawTtlDays,
      }) as Id<"crystalReflectionRuns">;
    } catch {
      reflectionRunId = undefined;
    }
    const finishReflectionRun = async (payload: Record<string, unknown>) => {
      if (!reflectionRunId) return;
      await ctx.runMutation((internal as any).crystal.reflectionLog.finishRun, {
        runId: reflectionRunId,
        ...payload,
      }).catch(() => {});
    };

    // 1. Fetch recent memories within the window
    const memories = (await ctx.runQuery(
      internal.crystal.reflection.getRecentMemoriesForReflection,
      {
        userId: args.userId,
        windowMs,
        limit: MAX_MEMORIES_FOR_REFLECTION,
      }
    )) as Array<{
      _id: string;
      store: string;
      title: string;
      content: string;
      tags: string[];
    }>;

    // 2. Skip if not enough context
    if (memories.length < MIN_MEMORIES_FOR_REFLECTION) {
      const reason = `only ${memories.length} memories in window (need at least ${MIN_MEMORIES_FOR_REFLECTION})`;
      console.log(
        `[reflection] user ${args.userId}: only ${memories.length} memories in window — skipping`
      );
      await finishReflectionRun({
        status: "completed",
        skipped: 1,
        errorMessage: reason,
      });
      return {
        memoriesRead: memories.length,
        decisionsWritten: 0,
        lessonsWritten: 0,
        summaryWritten: false,
        openLoopsWritten: 0,
        summary: "",
        skipped: reason,
      };
    }

    // 3. Build prompt and call OpenAI
    const prompt = buildReflectionPrompt(
      memories.map((m) => ({
        id: String(m._id),
        store: m.store,
        title: m.title,
        content: getMemoryEffectiveText(m) || m.content,
        tags: m.tags,
      }))
    );

    let reflection: ReflectionResult;

    try {
      const response = await fetch(OPENAI_COMPLETIONS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: REFLECTION_MODEL,
          temperature: REFLECTION_TEMPERATURE,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown error");
        console.log(`[reflection] OpenAI API error ${response.status}: ${errorText}`);
        await finishReflectionRun({
          status: "failed",
          errors: 1,
          errorMessage: `OpenAI API error: ${response.status}`,
        });
        return {
          memoriesRead: memories.length,
          decisionsWritten: 0,
          lessonsWritten: 0,
          summaryWritten: false,
          openLoopsWritten: 0,
          summary: "",
          skipped: `OpenAI API error: ${response.status}`,
        };
      }

      const payload = await response.json();
      const rawContent: string = payload?.choices?.[0]?.message?.content ?? "";

      if (!rawContent.trim()) {
        console.log(`[reflection] OpenAI returned empty content`);
        await finishReflectionRun({
          status: "failed",
          errors: 1,
          errorMessage: "OpenAI returned empty content",
        });
        return {
          memoriesRead: memories.length,
          decisionsWritten: 0,
          lessonsWritten: 0,
          summaryWritten: false,
          openLoopsWritten: 0,
          summary: "",
          skipped: "OpenAI returned empty content",
        };
      }

      // 4. Parse JSON — strip any accidental markdown fences
      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      reflection = JSON.parse(cleaned) as ReflectionResult;
    } catch (err) {
      console.log(`[reflection] Failed to call or parse OpenAI response:`, err);
      await finishReflectionRun({
        status: "failed",
        errors: 1,
        errorMessage: `LLM parse error: ${String(err)}`,
      });
      return {
        memoriesRead: memories.length,
        decisionsWritten: 0,
        lessonsWritten: 0,
        summaryWritten: false,
        openLoopsWritten: 0,
        summary: "",
        skipped: `LLM parse error: ${String(err)}`,
      };
    }

    // 5. Normalize and write back distilled memories
    const now = Date.now();
    const baseTags = ["reflection", "distilled", ...(Array.isArray(reflection.tags) ? reflection.tags : [])];
    const sessionId = args.sessionId;

    let decisionsWritten = 0;
    let lessonsWritten = 0;
    let summaryWritten = false;
    let openLoopsWritten = 0;
    let sourceSummariesWritten = 0;
    const touchedMemoryIds: Array<Id<"crystalMemories">> = [];
    const samples: Array<{ memoryId: Id<"crystalMemories">; title: string; action: string; reason?: string }> = [];

    const memorySummaries = Array.isArray(reflection.memorySummaries) ? reflection.memorySummaries : [];
    for (const item of memorySummaries) {
      const index = Number((item as any)?.index);
      const sourceSummary = typeof (item as any)?.summary === "string" ? (item as any).summary.trim() : "";
      if (!Number.isInteger(index) || index < 0 || index >= memories.length || !sourceSummary) continue;
      const sourceMemory = memories[index];
      if (sourceMemory.store !== "sensory") continue;
      try {
        const patched = await ctx.runMutation(internal.crystal.reflection.patchSourceMemorySummary, {
          memoryId: sourceMemory._id as Id<"crystalMemories">,
          summary: sourceSummary,
          summarySource: "baseline_reflection",
          summaryModel: REFLECTION_MODEL,
          summaryCostUsd: 0,
          reflectionRunId,
        });
        if (patched) {
          sourceSummariesWritten += 1;
          touchedMemoryIds.push(sourceMemory._id as Id<"crystalMemories">);
          if (samples.length < 10) {
            samples.push({
              memoryId: sourceMemory._id as Id<"crystalMemories">,
              title: sourceMemory.title,
              action: "summarized",
            });
          }
        }
      } catch (err) {
        console.log(`[reflection] Failed to patch source memory summary:`, err);
      }
    }

    // Write decisions → episodic/decision
    const decisions = Array.isArray(reflection.decisions) ? reflection.decisions : [];
    for (const decision of decisions) {
      if (!decision || typeof decision !== "string" || !decision.trim()) continue;
      try {
        const embedding = await embedText(decision);
        const memId = await ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
          userId: args.userId,
          store: "episodic",
          category: "decision",
          title: `Decision: ${decision.slice(0, 80)}`,
          content: decision,
          embedding,
          strength: 0.85,
          confidence: 0.8,
          valence: 0,
          arousal: 0.2,
          source: "inference",
          sessionId,
          tags: baseTags,
          archived: false,
        });
        void memId;
        decisionsWritten++;
      } catch (err) {
        console.log(`[reflection] Failed to write decision memory:`, err);
      }
    }

    // Write lessons → semantic/lesson
    const lessons = Array.isArray(reflection.lessons) ? reflection.lessons : [];
    for (const lesson of lessons) {
      if (!lesson || typeof lesson !== "string" || !lesson.trim()) continue;
      try {
        const embedding = await embedText(lesson);
        const memId = await ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
          userId: args.userId,
          store: "semantic",
          category: "lesson",
          title: `Lesson: ${lesson.slice(0, 80)}`,
          content: lesson,
          embedding,
          strength: 0.85,
          confidence: 0.8,
          valence: 0,
          arousal: 0.2,
          source: "inference",
          sessionId,
          tags: baseTags,
          archived: false,
        });
        void memId;
        lessonsWritten++;
      } catch (err) {
        console.log(`[reflection] Failed to write lesson memory:`, err);
      }
    }

    // Write session summary → episodic/event
    const summary = typeof reflection.summary === "string" ? reflection.summary.trim() : "";
    if (summary) {
      const dateStr = new Date(now).toISOString().slice(0, 10);
      try {
        const embedding = await embedText(summary);
        const memId = await ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
          userId: args.userId,
          store: "episodic",
          category: "conversation",
          title: `Reflection summary: ${dateStr}`,
          content: summary,
          embedding,
          strength: 0.8,
          confidence: 0.75,
          valence: 0,
          arousal: 0.2,
          source: "inference",
          sessionId,
          tags: baseTags,
          archived: false,
        });
        void memId;
        summaryWritten = true;
      } catch (err) {
        console.log(`[reflection] Failed to write summary memory:`, err);
      }
    }

    // Write open loops → prospective/goal
    const openLoops = Array.isArray(reflection.openLoops) ? reflection.openLoops : [];
    for (const loop of openLoops) {
      if (!loop || typeof loop !== "string" || !loop.trim()) continue;
      try {
        const embedding = await embedText(loop);
        const memId = await ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
          userId: args.userId,
          store: "prospective",
          category: "goal",
          title: `Open loop: ${loop.slice(0, 80)}`,
          content: loop,
          embedding,
          strength: 0.75,
          confidence: 0.7,
          valence: 0,
          arousal: 0.3,
          source: "inference",
          sessionId,
          tags: [...baseTags, "open-loop"],
          archived: false,
        });
        void memId;
        openLoopsWritten++;
      } catch (err) {
        console.log(`[reflection] Failed to write open loop memory:`, err);
      }
    }

    let lowSalienceReview: LowSalienceReviewResult = { promoted: 0, decayed: 0 };
    try {
      lowSalienceReview = await ctx.runAction(internal.crystal.reflection.reviewLowSalienceMemories, {
        userId: args.userId,
        windowHours,
      }) as LowSalienceReviewResult;
    } catch (err) {
      console.log(`[reflection] user ${args.userId}: low-salience review step failed`, err);
    }

    console.log(
      `[reflection] user ${args.userId}: read ${memories.length}, summarized ${sourceSummariesWritten}, wrote ${decisionsWritten} decisions, ${lessonsWritten} lessons, ${openLoopsWritten} open loops, summary: ${summaryWritten}, low-salience promoted ${lowSalienceReview.promoted}, decayed ${lowSalienceReview.decayed}`
    );

    await finishReflectionRun({
      status: "completed",
      summarized: sourceSummariesWritten,
      promoted: decisionsWritten + lessonsWritten + openLoopsWritten + (summaryWritten ? 1 : 0),
      archived: lowSalienceReview.decayed,
      errors: 0,
      memoryIds: touchedMemoryIds.slice(0, 100),
      samples,
    });

    return {
      memoriesRead: memories.length,
      decisionsWritten,
      lessonsWritten,
      summaryWritten,
      openLoopsWritten,
      summary,
    };
  },
});

// ── Public action: cron entry point (iterates all users) ─────────────────────

export const runReflection = action({
  args: {
    windowHours: v.optional(v.number()),
    sessionId: v.optional(v.id("crystalSessions")),
  },
  handler: async (ctx, args) => {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.log("[reflection] OPENAI_API_KEY not set — skipping");
      return { skipped: true, reason: "no OPENAI_API_KEY" };
    }

    const userIds: string[] = await ctx.runQuery(
      internal.crystal.userProfiles.listAllUserIds,
      {}
    );

    const results: Array<{ userId: string } & ReflectionStats> = [];

    for (const userId of userIds) {
      try {
        const result = await ctx.runAction(
          internal.crystal.reflection.runReflectionForUser,
          {
            userId,
            windowHours: args.windowHours,
            sessionId: args.sessionId,
            openaiApiKey,
          }
        );
        results.push({ userId, ...(result as ReflectionStats) });
      } catch (err) {
        console.log(`[reflection] user ${userId} failed:`, err);
      }
    }

    return {
      users: results.length,
      results,
    };
  },
});
