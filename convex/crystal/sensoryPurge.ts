import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta } from "./dashboardTotals";

// ── Noise pattern matching ──────────────────────────────────────────────────

type PatternName =
  | "heartbeat_ok"
  | "no_reply"
  | "unchanged_heartbeat"
  | "short_system"
  | "system_exec";

interface NoiseMatch {
  pattern: PatternName;
}

function matchNoise(content: string, title: string): NoiseMatch | null {
  const trimmed = content.trim();

  // Content is entirely a HEARTBEAT_OK response (with optional "Assistant:" prefix)
  const stripped = trimmed.replace(/^Assistant:\s*/i, "").trim();
  if (stripped === "HEARTBEAT_OK") {
    return { pattern: "heartbeat_ok" };
  }

  // "Unchanged. HEARTBEAT_OK" or similar heartbeat non-responses
  if (/\bHEARTBEAT_OK\b/.test(stripped) && stripped.length < 200) {
    return { pattern: "unchanged_heartbeat" };
  }

  // Content ends with NO_REPLY as the entire assistant response
  if (stripped === "NO_REPLY") {
    return { pattern: "no_reply" };
  }
  // Content is a short message that ends with NO_REPLY
  if (/\bNO_REPLY\s*$/.test(stripped) && stripped.length < 200) {
    return { pattern: "no_reply" };
  }

  // Short system messages: < 30 chars and title starts with "OpenClaw"
  if (stripped.length < 30 && title.startsWith("OpenClaw")) {
    return { pattern: "short_system" };
  }

  // Tool-only / system exec output (anywhere in content)
  if (/^(Assistant:\s*)?System:\s*\[/.test(trimmed) && trimmed.length < 200) {
    return { pattern: "system_exec" };
  }

  return null;
}

type AggressivePatternName =
  | PatternName
  | "short_auto_capture"
  | "short_openclaw_log";

type MemoryScanDoc = {
  _id: Id<"crystalMemories">;
  createdAt: number;
  store: string;
  title: string;
  content: string;
  tags: string[];
};

type TopMemoryShape = {
  id: string;
  title: string;
  store: string;
  length: number;
  ageDays: number;
  tags: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function matchNoiseAggressive(
  content: string,
  title: string,
  tags: string[],
): { pattern: AggressivePatternName } | null {
  // First check standard patterns
  const standard = matchNoise(content, title);
  if (standard) return { pattern: standard.pattern };

  const trimmed = content.trim();

  // Short auto-capture: has "auto-capture" tag and content < 100 chars
  if (tags.includes("auto-capture") && trimmed.length < 100) {
    return { pattern: "short_auto_capture" };
  }

  // Short OpenClaw conversation log: title matches "OpenClaw — YYYY-MM-DD HH:MM" and content < 50 chars
  if (/^OpenClaw\s[—–-]\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(title) && trimmed.length < 50) {
    return { pattern: "short_openclaw_log" };
  }

  return null;
}

function incrementCount(counts: Record<string, number>, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

function ageBucket(createdAt: number, now: number) {
  const ageDays = Math.max(0, Math.floor((now - createdAt) / DAY_MS));
  if (ageDays < 7) return "lt7";
  if (ageDays < 14) return "d7_14";
  if (ageDays < 30) return "d14_30";
  if (ageDays < 90) return "d30_90";
  return "d90plus";
}

function addSizeBucket(counts: Record<string, number>, length: number) {
  if (length > 1000) incrementCount(counts, "gt1000");
  if (length > 2500) incrementCount(counts, "gt2500");
  if (length > 5000) incrementCount(counts, "gt5000");
  if (length > 10000) incrementCount(counts, "gt10000");
}

function addTopMemory(list: TopMemoryShape[], candidate: TopMemoryShape) {
  list.push(candidate);
  list.sort((a, b) => b.length - a.length);
  if (list.length > 12) list.length = 12;
}

// ── Paginated reader ────────────────────────────────────────────────────────

export const scanMemoryPage = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.number(),
  },
  handler: async (ctx, { userId, cursor, limit }) => {
    const safe = Math.min(limit, 100);

    // Use Convex's opaque paginator cursor — correctly handles rows sharing the same
    // `createdAt` millisecond (the previous DIY `gt("createdAt", cursor)` cursor
    // silently dropped ties at page boundaries and could miss matching sensory rows).
    const result = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (idx) => idx.eq("userId", userId))
      .paginate({ numItems: safe, cursor: cursor ?? null });
    // Return all non-archived memories; caller filters by store
    const active = result.page.filter((doc) => !doc.archived);
    return {
      page: active.map((doc) => ({
        _id: doc._id,
        createdAt: doc.createdAt,
        store: doc.store,
        title: doc.title,
        content: doc.content,
        tags: doc.tags ?? [],
      })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// ── Read-only diagnostics ──────────────────────────────────────────────────

export const reportMemoryBloat = internalAction({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    let cursor: string | null = null;
    let scanned = 0;

    const byStore: Record<string, number> = {};
    const charByStore: Record<string, number> = {};
    const ageBuckets: Record<string, number> = {
      lt7: 0,
      d7_14: 0,
      d14_30: 0,
      d30_90: 0,
      d90plus: 0,
    };
    const sizeBucketsByStore: Record<string, Record<string, number>> = {};
    const sensoryTags: Record<string, number> = {};
    const narrowNoisePatterns: Record<string, number> = {};
    const aggressiveNoisePatterns: Record<string, number> = {};
    const topAll: TopMemoryShape[] = [];
    const topSensory: TopMemoryShape[] = [];

    type ScanMemoryPageResult = {
      page: MemoryScanDoc[];
      continueCursor: string | null;
      isDone: boolean;
    };

    while (true) {
      const result: ScanMemoryPageResult = await ctx.runQuery(
        internal.crystal.sensoryPurge.scanMemoryPage,
        { userId, cursor, limit: 100 },
      );

      for (const doc of result.page) {
        const length = doc.content.length;
        const store = doc.store || "unknown";
        const ageDays = Math.max(0, Math.floor((now - doc.createdAt) / DAY_MS));

        scanned++;
        incrementCount(byStore, store);
        incrementCount(charByStore, store, length);
        incrementCount(ageBuckets, ageBucket(doc.createdAt, now));

        sizeBucketsByStore[store] ??= {};
        addSizeBucket(sizeBucketsByStore[store], length);

        const topShape: TopMemoryShape = {
          id: doc._id,
          title: doc.title,
          store,
          length,
          ageDays,
          tags: doc.tags.slice(0, 8),
        };
        addTopMemory(topAll, topShape);

        if (store === "sensory") {
          addTopMemory(topSensory, topShape);
          for (const tag of doc.tags) incrementCount(sensoryTags, tag);

          const narrowMatch = matchNoise(doc.content, doc.title);
          if (narrowMatch) incrementCount(narrowNoisePatterns, narrowMatch.pattern);

          const aggressiveMatch = matchNoiseAggressive(doc.content, doc.title, doc.tags);
          if (aggressiveMatch) {
            incrementCount(aggressiveNoisePatterns, aggressiveMatch.pattern);
          }
        }
      }

      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    const topSensoryTags = Object.fromEntries(
      Object.entries(sensoryTags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    );

    return {
      scanned,
      byStore,
      charByStore,
      ageBuckets,
      sizeBucketsByStore,
      topSensoryTags,
      narrowNoiseMatches: Object.values(narrowNoisePatterns).reduce((sum, count) => sum + count, 0),
      narrowNoisePatterns,
      aggressiveNoiseMatches: Object.values(aggressiveNoisePatterns).reduce(
        (sum, count) => sum + count,
        0,
      ),
      aggressiveNoisePatterns,
      topAll,
      topSensory,
    };
  },
});

// ── Batch delete ────────────────────────────────────────────────────────────

export const batchDeleteMemories = internalMutation({
  args: { ids: v.array(v.id("crystalMemories")) },
  handler: async (ctx, { ids }) => {
    let deleted = 0;
    for (const id of ids) {
      const memory = await ctx.db.get(id);
      if (!memory) continue;
      const wasArchived = Boolean(memory.archived);
      const activeAccessCount = wasArchived ? 0 : Math.max(0, Math.floor(memory.accessCount ?? 0));
      await applyDashboardTotalsDelta(ctx, memory.userId, {
        totalMemoriesDelta: -1,
        activeMemoriesDelta: wasArchived ? 0 : -1,
        archivedMemoriesDelta: wasArchived ? -1 : 0,
        enrichedMemoriesDelta: !wasArchived && memory.graphEnriched === true ? -1 : 0,
        graphEligiblePendingMemoriesDelta:
          !wasArchived && memory.graphEnriched !== true && !memory.enrichmentSkippedReason ? -1 : 0,
        graphSkippedMemoriesDelta:
          !wasArchived && memory.graphEnriched !== true && memory.enrichmentSkippedReason ? -1 : 0,
        activeRecallCountDelta: -activeAccessCount,
        activeRecalledMemoriesDelta: activeAccessCount > 0 ? -1 : 0,
        activeMemoriesByStoreDelta: wasArchived ? {} : { [memory.store]: -1 },
      });
      await ctx.db.delete(id);
      deleted += 1;
    }
    return { deleted };
  },
});

// ── Main purge: narrow noise patterns ───────────────────────────────────────

export const purgeSensoryNoise = internalAction({
  args: {
    userId: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, dryRun }) => {
    const isDryRun = dryRun ?? true; // default to dry run for safety
    let cursor: string | null = null;
    let scanned = 0;
    let deleted = 0;
    const patterns: Record<string, number> = {};
    let deleteBatch: Id<"crystalMemories">[] = [];
    type ScanMemoryPageResult = {
      page: Array<{ _id: Id<"crystalMemories">; createdAt: number; store: string; title: string; content: string; tags: string[] }>;
      continueCursor: string | null;
      isDone: boolean;
    };

    while (true) {
      const result: ScanMemoryPageResult = await ctx.runQuery(
        internal.crystal.sensoryPurge.scanMemoryPage,
        { userId, cursor, limit: 100 },
      );
      const { page, continueCursor, isDone } = result;
      if (page.length === 0 && isDone) break;

      for (const doc of page) {
        scanned++;
        if (doc.store !== "sensory") continue;
        const match = matchNoise(doc.content, doc.title);
        if (match) {
          patterns[match.pattern] = (patterns[match.pattern] ?? 0) + 1;
          if (!isDryRun) {
            deleteBatch.push(doc._id);
            if (deleteBatch.length >= 100) {
              await ctx.runMutation(
                internal.crystal.sensoryPurge.batchDeleteMemories,
                { ids: deleteBatch },
              );
              deleted += deleteBatch.length;
              deleteBatch = [];
            }
          } else {
            deleted++;
          }
        }
      }

      if (isDone) break;
      cursor = continueCursor;

      if (scanned % 500 === 0) {
        console.log(
          `[sensory-purge] scanned ${scanned}, matched ${deleted} so far (dryRun=${isDryRun})`,
        );
      }
    }

    // Flush remaining batch
    if (!isDryRun && deleteBatch.length > 0) {
      await ctx.runMutation(
        internal.crystal.sensoryPurge.batchDeleteMemories,
        { ids: deleteBatch },
      );
      deleted += deleteBatch.length;
    }

    console.log(
      `[sensory-purge] DONE: scanned=${scanned} deleted=${deleted} dryRun=${isDryRun} patterns=${JSON.stringify(patterns)}`,
    );

    return { scanned, deleted, patterns, dryRun: isDryRun };
  },
});

// ── Aggressive purge: includes short auto-captures ──────────────────────────

export const purgeNoisyConversationLogs = internalAction({
  args: {
    userId: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, dryRun }) => {
    const isDryRun = dryRun ?? true;
    let cursor: string | null = null;
    let scanned = 0;
    let deleted = 0;
    const patterns: Record<string, number> = {};
    let deleteBatch: Id<"crystalMemories">[] = [];
    type ScanMemoryPageResult = {
      page: Array<{ _id: Id<"crystalMemories">; createdAt: number; store: string; title: string; content: string; tags: string[] }>;
      continueCursor: string | null;
      isDone: boolean;
    };

    while (true) {
      const result: ScanMemoryPageResult = await ctx.runQuery(
        internal.crystal.sensoryPurge.scanMemoryPage,
        { userId, cursor, limit: 100 },
      );
      const { page, continueCursor, isDone } = result;
      if (page.length === 0 && isDone) break;

      for (const doc of page) {
        scanned++;
        if (doc.store !== "sensory") continue;
        const match = matchNoiseAggressive(doc.content, doc.title, doc.tags);
        if (match) {
          patterns[match.pattern] = (patterns[match.pattern] ?? 0) + 1;
          if (!isDryRun) {
            deleteBatch.push(doc._id);
            if (deleteBatch.length >= 100) {
              await ctx.runMutation(
                internal.crystal.sensoryPurge.batchDeleteMemories,
                { ids: deleteBatch },
              );
              deleted += deleteBatch.length;
              deleteBatch = [];
            }
          } else {
            deleted++;
          }
        }
      }

      if (isDone) break;
      cursor = continueCursor;

      if (scanned % 500 === 0) {
        console.log(
          `[sensory-purge-aggressive] scanned ${scanned}, matched ${deleted} so far (dryRun=${isDryRun})`,
        );
      }
    }

    if (!isDryRun && deleteBatch.length > 0) {
      await ctx.runMutation(
        internal.crystal.sensoryPurge.batchDeleteMemories,
        { ids: deleteBatch },
      );
      deleted += deleteBatch.length;
    }

    console.log(
      `[sensory-purge-aggressive] DONE: scanned=${scanned} deleted=${deleted} dryRun=${isDryRun} patterns=${JSON.stringify(patterns)}`,
    );

    return { scanned, deleted, patterns, dryRun: isDryRun };
  },
});
