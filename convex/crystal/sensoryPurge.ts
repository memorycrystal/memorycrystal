import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";

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

// ── Paginated reader ────────────────────────────────────────────────────────

export const scanMemoryPage = internalQuery({
  args: { userId: v.string(), afterCreatedAt: v.number(), limit: v.number() },
  handler: async (ctx, { userId, afterCreatedAt, limit }) => {
    const safe = Math.min(limit, 100);
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (idx) => {
        const base = idx.eq("userId", userId);
        return afterCreatedAt > 0 ? base.gt("createdAt", afterCreatedAt) : base;
      })
      .take(safe);
    // Return all non-archived memories; caller filters by store
    const active = page.filter((doc) => !doc.archived);
    return active.map((doc) => ({
      _id: doc._id,
      createdAt: doc.createdAt,
      store: doc.store,
      title: doc.title,
      content: doc.content,
      tags: doc.tags,
    }));
  },
});

// ── Batch delete ────────────────────────────────────────────────────────────

export const batchDeleteMemories = internalMutation({
  args: { ids: v.array(v.id("crystalMemories")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.delete(id);
    }
    return { deleted: ids.length };
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
    let cursor = 0;
    let scanned = 0;
    let deleted = 0;
    const patterns: Record<string, number> = {};
    let deleteBatch: Id<"crystalMemories">[] = [];

    while (true) {
      const page = await ctx.runQuery(
        internal.crystal.sensoryPurge.scanMemoryPage,
        { userId, afterCreatedAt: cursor, limit: 100 },
      );
      if (page.length === 0) break;

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

      cursor = page[page.length - 1].createdAt;

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
    let cursor = 0;
    let scanned = 0;
    let deleted = 0;
    const patterns: Record<string, number> = {};
    let deleteBatch: Id<"crystalMemories">[] = [];

    while (true) {
      const page = await ctx.runQuery(
        internal.crystal.sensoryPurge.scanMemoryPage,
        { userId, afterCreatedAt: cursor, limit: 100 },
      );
      if (page.length === 0) break;

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

      cursor = page[page.length - 1].createdAt;

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
