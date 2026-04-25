import { stableUserId } from "./auth";
import { query } from "../_generated/server";
import { v } from "convex/values";
import { TIER_LIMITS, TIER_ORDER, type UserTier } from "../../shared/tierLimits";
import { resolveEffectiveUserId } from "./impersonation";
import { getDashboardTotals } from "./dashboardTotals";
import { getUnlimitedEmails } from "./adminEmails";

const nowMs = () => Date.now();
const msPerDay = 24 * 60 * 60 * 1000;

const PROFILE_SAMPLE_LIMIT = 20;
// Keep sample sizes small to stay well within Convex's 8MB read limit.
// For exact counts, we use the pre-computed dashboardTotals table.
const ACTIVE_MEMORY_SAMPLE_LIMIT = 500;
const ARCHIVED_MEMORY_SAMPLE_LIMIT = 100;
const MESSAGE_SAMPLE_LIMIT = 100;
const SESSION_SAMPLE_LIMIT = 100;
const CHECKPOINT_SAMPLE_LIMIT = 100;

export const health = query({
  args: {},
  handler: async () => {
    const backend = process.env.CRYSTAL_BACKEND === "local" ? "self-hosted" : "cloud";
    return {
      ok: true,
      serverTime: Date.now(),
      backendMode: backend,
    };
  },
});

function pickLatestProfile<T extends { updatedAt?: number }>(profiles: T[]): T | undefined {
  return profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

const PRO_PRODUCT_ID = "f78ee82b-719e-4de8-850a-3e9eea3db4b0";
const ULTRA_PRODUCT_ID = "9d59dd76-5026-4079-95f7-bf594f71121b";
function deriveTierFromProfile(
  profile: { subscriptionStatus?: string; plan?: string } | null | undefined,
  email: string,
): UserTier {
  if (getUnlimitedEmails().includes(email.toLowerCase())) return "unlimited";
  if (profile?.subscriptionStatus === "unlimited") return "unlimited";
  if (profile?.subscriptionStatus !== "active" && profile?.subscriptionStatus !== "trialing") return "free";
  const plan = (profile?.plan ?? "").toLowerCase();
  if (plan === ULTRA_PRODUCT_ID || plan === "ultra") return "ultra";
  if (plan === PRO_PRODUCT_ID || plan === "pro") return "pro";
  if (plan === "starter") return "starter";
  return "pro";
}

// ─── getUserUsageStats ────────────────────────────────────────────────────────

export const getUserUsageStats = query({
  args: { asUserId: v.optional(v.string()) },
  handler: async (ctx, { asUserId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const actorUserId = stableUserId(identity.subject);
    const userId = await resolveEffectiveUserId(ctx, actorUserId, asUserId);
    const email = (identity.email ?? "").toLowerCase();

    // -- Derive tier from profile --
    const profileSample = await ctx.db
      .query("crystalUserProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PROFILE_SAMPLE_LIMIT);
    const profile = pickLatestProfile(profileSample);
    const tier = deriveTierFromProfile(profile, email);
    const limits = TIER_LIMITS[tier];
    const subscriptionStatus = profile?.subscriptionStatus ?? "inactive";

    // -- Use pre-computed totals for counts (avoids 8MB read limit) --
    const totals = await getDashboardTotals(ctx, userId);
    const totalMemories = totals?.activeMemories ?? 0;
    const archivedMemories = totals?.archivedMemories ?? 0;
    const totalStmMessages = totals?.totalMessages ?? 0;

    // -- Sample active memories for breakdown stats (store, category, age) --
    const activeSample = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
      .take(ACTIVE_MEMORY_SAMPLE_LIMIT + 1);

    const activeBounded = activeSample.length > ACTIVE_MEMORY_SAMPLE_LIMIT;
    const activeMemories = activeSample.slice(0, ACTIVE_MEMORY_SAMPLE_LIMIT);

    // -- Breakdown by store (from pre-computed totals if available, else sample) --
    const byStore = totals?.activeMemoriesByStore
      ? {
          sensory: totals.activeMemoriesByStore.sensory ?? 0,
          episodic: totals.activeMemoriesByStore.episodic ?? 0,
          semantic: totals.activeMemoriesByStore.semantic ?? 0,
          procedural: totals.activeMemoriesByStore.procedural ?? 0,
          prospective: totals.activeMemoriesByStore.prospective ?? 0,
        }
      : (() => {
          const raw: Record<string, number> = {};
          for (const m of activeMemories) raw[m.store] = (raw[m.store] ?? 0) + 1;
          return {
            sensory: raw["sensory"] ?? 0,
            episodic: raw["episodic"] ?? 0,
            semantic: raw["semantic"] ?? 0,
            procedural: raw["procedural"] ?? 0,
            prospective: raw["prospective"] ?? 0,
          };
        })();

    // -- Category breakdown and age stats (from sample) --
    const byCategory: Record<string, number> = {};
    let oldestMs: number | null = null;
    let newestMs: number | null = null;

    for (const m of activeMemories) {
      if (m.category) {
        byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
      }
      if (oldestMs === null || m.createdAt < oldestMs) oldestMs = m.createdAt;
      if (newestMs === null || m.createdAt > newestMs) newestMs = m.createdAt;
    }

    const now = nowMs();
    const oldestMemoryDays = oldestMs !== null ? Math.floor((now - oldestMs) / msPerDay) : null;
    const newestMemoryDays = newestMs !== null ? Math.floor((now - newestMs) / msPerDay) : null;

    // -- Sessions (small sample for count) --
    const sessionSample = await ctx.db
      .query("crystalSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(SESSION_SAMPLE_LIMIT + 1);
    const sessionsBounded = sessionSample.length > SESSION_SAMPLE_LIMIT;
    const totalSessions = sessionSample.slice(0, SESSION_SAMPLE_LIMIT).length;

    // -- Checkpoints (small sample for count) --
    const checkpointSample = await ctx.db
      .query("crystalCheckpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(CHECKPOINT_SAMPLE_LIMIT + 1);
    const checkpointsBounded = checkpointSample.length > CHECKPOINT_SAMPLE_LIMIT;
    const checkpoints = checkpointSample.slice(0, CHECKPOINT_SAMPLE_LIMIT).length;

    // -- Percentages --
    const memoriesUsedPercent =
      limits.memories !== null ? Math.min(100, Math.round((totalMemories / limits.memories) * 100)) : 0;
    const stmUsedPercent =
      limits.stmMessages !== null ? Math.min(100, Math.round((totalStmMessages / limits.stmMessages) * 100)) : 0;

    // -- upgradeAvailable --
    const tierIdx = TIER_ORDER.indexOf(tier);
    const upgradeAvailable = tierIdx < TIER_ORDER.indexOf("ultra");

    const usageNote =
      activeBounded || sessionsBounded || checkpointsBounded
        ? `Some breakdown stats are approximate; sampling caps: active=${ACTIVE_MEMORY_SAMPLE_LIMIT}, sessions=${SESSION_SAMPLE_LIMIT}, checkpoints=${CHECKPOINT_SAMPLE_LIMIT}. Totals use pre-computed counts.`
        : undefined;

    return {
      tier,
      plan: profile?.plan ?? tier,
      limits,
      usage: {
        totalMemories,
        archivedMemories,
        totalStmMessages,
        memoriesUsedPercent,
        stmUsedPercent,
        byStore,
        byCategory,
        oldestMemoryDays,
        newestMemoryDays,
        totalSessions,
        checkpoints,
      },
      usageNote,
      subscriptionStatus,
      upgradeAvailable,
    };
  },
});

export const getMemoryStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const userId = stableUserId(identity.subject);

    const sampleLimit = 500;
    const sample = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", false))
      .take(sampleLimit + 1);

    const bounded = sample.length > sampleLimit;
    const active = sample.slice(0, sampleLimit);
    const now = nowMs();

    // Also count archived
    const archivedSample = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", userId).eq("archived", true))
      .take(sampleLimit);

    const archivedCount = archivedSample.length;

    const byStore = active.reduce<Record<string, number>>((acc, memory) => {
      acc[memory.store] = (acc[memory.store] ?? 0) + 1;
      return acc;
    }, {});

    const strengthSum = active.reduce((sum, memory) => sum + memory.strength, 0);
    const averageStrength = active.length > 0 ? strengthSum / active.length : 0;

    const last24h = now - msPerDay;
    const capturesLast24h = active.filter((memory) => memory.createdAt >= last24h).length;

    const strongest = active
      .slice()
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map((memory) => ({
        memoryId: memory._id,
        title: memory.title,
        store: memory.store,
        strength: memory.strength,
        confidence: memory.confidence,
      }));

    return {
      totalMemories: active.length + archivedCount,
      archivedCount,
      byStore,
      avgStrength: averageStrength,
      recentCaptures: capturesLast24h,
      activeMemories: active.length,
      strongest,
      statsNote: bounded ? `Stats are approximate; capped at ${sampleLimit} memories.` : undefined,
    };
  },
});
