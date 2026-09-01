import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { applyDashboardTotalsDelta } from "./dashboardTotals";
import { stableUserId } from "./auth";
import { canPerformWriteActions, normalizeRoles } from "./permissions";
import { isProtectedSensoryCapture } from "./sensoryPolicy";

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
const DEFAULT_STALE_OPENCLAW_RESIDUE_AGE_DAYS = 30;
const DEFAULT_STALE_OPENCLAW_RESIDUE_LIMIT = 500;
const MAX_STALE_OPENCLAW_RESIDUE_LIMIT = 1000;
const STALE_OPENCLAW_RESIDUE_PAGE_SIZE = 50;
const STALE_OPENCLAW_RESIDUE_MAX_BYTES = 512 * 1024;

type StaleOpenClawResidueDoc = {
  _id: Id<"crystalMemories">;
  userId: string;
  store: string;
  category: string;
  title: string;
  source: string;
  tags: string[];
  createdAt: number;
  accessCount?: number;
  archived: boolean;
  graphEnriched?: boolean;
  enrichmentSkippedReason?: string;
  knowledgeBaseId?: Id<"knowledgeBases">;
};

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

function clampWholeNumber(value: number | undefined, fallback: number, min: number, max: number) {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, raw));
}

function normalizedTagSet(tags: string[] | undefined) {
  return new Set((tags ?? []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean));
}

function isStaleOpenClawSensoryResidue(
  memory: StaleOpenClawResidueDoc,
  options: { now: number; minAgeDays: number; maxAccessCount: number },
) {
  if (memory.archived) return false;
  if (memory.store !== "sensory") return false;
  if (memory.enrichmentSkippedReason !== "sensory_skip") return false;
  if (memory.graphEnriched === true) return false;
  if (memory.knowledgeBaseId) return false;
  if (memory.source !== "external") return false;
  if (isProtectedSensoryCapture(memory)) return false;

  const tags = normalizedTagSet(memory.tags);
  if (!tags.has("openclaw") || !tags.has("auto-capture")) return false;
  if (Math.max(0, memory.accessCount ?? 0) > options.maxAccessCount) return false;

  return options.now - memory.createdAt >= options.minAgeDays * DAY_MS;
}

async function requireSensoryMaintenanceAccess(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated: sensory maintenance requires manager or admin access");

  const actorUserId = stableUserId(identity.subject);
  const access = await ctx.runQuery(internal.crystal.sensoryPurge.getSensoryMaintenanceAccess, {
    viewerId: actorUserId,
  }) as { allowed: boolean };
  if (!access.allowed) {
    throw new Error("Forbidden: sensory maintenance requires manager or admin access");
  }
  return actorUserId;
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

export const getSensoryMaintenanceAccess = internalQuery({
  args: { viewerId: v.string() },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.viewerId))
      .collect();
    const latestProfile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    return { allowed: canPerformWriteActions(normalizeRoles((latestProfile as any)?.roles)) };
  },
});

export const listStaleOpenClawSensoryResiduePage = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.number(),
    minAgeDays: v.number(),
    maxAccessCount: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const page: any = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_skip_reason", (q) =>
        q
          .eq("userId", args.userId)
          .eq("archived", false)
          .eq("enrichmentSkippedReason", "sensory_skip")
      )
      .paginate({
        numItems: clampWholeNumber(args.pageSize, STALE_OPENCLAW_RESIDUE_PAGE_SIZE, 1, STALE_OPENCLAW_RESIDUE_PAGE_SIZE),
        cursor: args.cursor ?? null,
        maximumBytesRead: STALE_OPENCLAW_RESIDUE_MAX_BYTES,
      });

    const candidates = (page.page as StaleOpenClawResidueDoc[])
      .filter((memory) =>
        isStaleOpenClawSensoryResidue(memory, {
          now: args.now,
          minAgeDays: args.minAgeDays,
          maxAccessCount: args.maxAccessCount,
        })
      )
      .map((memory) => ({
        _id: memory._id,
        title: memory.title,
        createdAt: memory.createdAt,
        accessCount: memory.accessCount ?? 0,
        tags: memory.tags ?? [],
      }));

    return {
      candidates,
      scanned: page.page.length,
      continueCursor: page.continueCursor as string | null,
      isDone: Boolean(page.isDone),
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
        // ILL-179 — KB chunks are not sensory captures today, but this batch
        // delete is generic over crystalMemories, so keep the counter honest.
        knowledgeBaseMemoriesDelta: !wasArchived && memory.knowledgeBaseId ? -1 : 0,
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

export const writeSensoryPurgeAuditLog = internalMutation({
  args: {
    actorUserId: v.string(),
    targetUserId: v.string(),
    action: v.string(),
    meta: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("crystalAuditLog", {
      userId: args.actorUserId,
      keyHash: "admin_console",
      action: args.action,
      ts: Date.now(),
      actorUserId: args.actorUserId,
      effectiveUserId: args.actorUserId,
      targetUserId: args.targetUserId,
      targetType: "crystalMemories",
      meta: args.meta,
    });
  },
});

export const purgeStaleOpenClawSensoryResidue = action({
  args: {
    userId: v.string(),
    dryRun: v.optional(v.boolean()),
    minAgeDays: v.optional(v.number()),
    maxAccessCount: v.optional(v.number()),
    maxMemories: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{
    userId: string;
    dryRun: boolean;
    minAgeDays: number;
    maxAccessCount: number;
    maxMemories: number;
    scanned: number;
    matched: number;
    deleted: number;
    done: boolean;
    samples: Array<{
      id: string;
      title: string;
      ageDays: number;
      accessCount: number;
      tags: string[];
    }>;
  }> => {
    const actorUserId = await requireSensoryMaintenanceAccess(ctx);
    const dryRun = args.dryRun ?? true;
    const minAgeDays = clampWholeNumber(
      args.minAgeDays,
      DEFAULT_STALE_OPENCLAW_RESIDUE_AGE_DAYS,
      1,
      3650,
    );
    const maxAccessCount = clampWholeNumber(args.maxAccessCount, 0, 0, 100);
    const maxMemories = clampWholeNumber(
      args.maxMemories,
      DEFAULT_STALE_OPENCLAW_RESIDUE_LIMIT,
      1,
      MAX_STALE_OPENCLAW_RESIDUE_LIMIT,
    );
    const now = Date.now();

    let cursor: string | null = null;
    let scanned = 0;
    let matched = 0;
    let deleted = 0;
    let done = false;
    const samples: Array<{
      id: string;
      title: string;
      ageDays: number;
      accessCount: number;
      tags: string[];
    }> = [];

    while (matched < maxMemories) {
      const page = await ctx.runQuery(internal.crystal.sensoryPurge.listStaleOpenClawSensoryResiduePage, {
        userId: args.userId,
        cursor,
        pageSize: STALE_OPENCLAW_RESIDUE_PAGE_SIZE,
        minAgeDays,
        maxAccessCount,
        now,
      }) as {
        candidates: Array<{
          _id: Id<"crystalMemories">;
          title: string;
          createdAt: number;
          accessCount: number;
          tags: string[];
        }>;
        scanned: number;
        continueCursor: string | null;
        isDone: boolean;
      };

      scanned += page.scanned;
      const remaining = maxMemories - matched;
      const candidates = page.candidates.slice(0, remaining);
      if (candidates.length > 0) {
        matched += candidates.length;
        for (const memory of candidates.slice(0, Math.max(0, 12 - samples.length))) {
          samples.push({
            id: String(memory._id),
            title: memory.title,
            ageDays: Math.max(0, Math.floor((now - memory.createdAt) / DAY_MS)),
            accessCount: memory.accessCount,
            tags: memory.tags.slice(0, 8),
          });
        }

        if (!dryRun) {
          const result = await ctx.runMutation(internal.crystal.sensoryPurge.batchDeleteMemories, {
            ids: candidates.map((candidate) => candidate._id),
          }) as { deleted: number };
          deleted += result.deleted;
        }
      }

      if (page.isDone || !page.continueCursor) {
        done = true;
        break;
      }
      cursor = page.continueCursor;
    }

    try {
      await ctx.runMutation(internal.crystal.sensoryPurge.writeSensoryPurgeAuditLog, {
        actorUserId,
        targetUserId: args.userId,
        action: dryRun ? "sensory_residue_purge_dry_run" : "sensory_residue_purge_execute",
        meta: JSON.stringify({
          dryRun,
          minAgeDays,
          maxAccessCount,
          maxMemories,
          scanned,
          matched,
          deleted,
          done,
        }),
      });
    } catch {
      // Maintenance audit logging must not turn a successful cleanup into a failure.
    }

    return {
      userId: args.userId,
      dryRun,
      minAgeDays,
      maxAccessCount,
      maxMemories,
      scanned,
      matched,
      deleted,
      done,
      samples,
    };
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
