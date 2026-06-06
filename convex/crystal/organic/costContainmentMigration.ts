/**
 * costContainmentMigration.ts
 *
 * One-off, run-once-after-deploy migration that immediately enforces organic
 * cost-containment gates on ALL existing organicTickState rows without waiting
 * for the lazy self-disable path inside processUserTick.
 *
 * Safe to delete after the migration has been confirmed run in production.
 *
 * Idempotency guarantee:
 *   - Disabled rows have `enabled = false` → no longer returned by the
 *     `by_enabled` index scan, so a second run simply skips them.
 *   - Clamped rows already have `tickIntervalMs >= ORGANIC_MIN_INTERVAL_MS`
 *     → the interval check is false, so no write is performed a second time.
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { deriveTier } from "../userProfiles";
import { isOrganicEligibleTier } from "../retention";
import { clampTickIntervalMs, ORGANIC_MIN_INTERVAL_MS } from "./spend";

export const runCostContainmentMigration = internalMutation({
  args: {
    /** When true, audit without writing — useful for a pre-flight check. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { dryRun = false }): Promise<{
    scanned: number;
    disabled: number;
    clamped: number;
    dryRun: boolean;
  }> => {
    // Step 1: collect every row currently marked enabled = true.
    // The by_enabled index makes this a cheap index scan, not a full table scan.
    const enabledRows = await ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .collect();

    let disabled = 0;
    let clamped = 0;

    for (const row of enabledRows) {
      // Step 2: resolve the user's tier directly from crystalUserProfiles,
      // matching the same logic getUserTier / deriveTier use — avoids calling
      // an internalQuery from within a mutation (not always supported).
      const profiles = await ctx.db
        .query("crystalUserProfiles")
        .withIndex("by_user", (q) => q.eq("userId", row.userId))
        .collect();

      // Pick the most-recently-updated profile (mirrors pickLatestProfile in userProfiles.ts).
      const profile = profiles.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
      const tier = deriveTier(profile);

      if (!isOrganicEligibleTier(tier)) {
        // User is not on ultra/unlimited — disable organic immediately.
        if (!dryRun) {
          const now = Date.now();
          await ctx.db.patch(row._id, {
            enabled: false,
            lastSkipReason: "organic_requires_ultra",
            lastSkippedAt: now,
            updatedAt: now,
          });
        }
        disabled++;
        continue; // interval clamp is moot for disabled rows
      }

      // Step 3: clamp sub-12h intervals for eligible users.
      if (row.tickIntervalMs < ORGANIC_MIN_INTERVAL_MS) {
        const clamped_ms = clampTickIntervalMs(row.tickIntervalMs);
        if (!dryRun) {
          await ctx.db.patch(row._id, {
            tickIntervalMs: clamped_ms,
            updatedAt: Date.now(),
          });
        }
        clamped++;
      }
    }

    return { scanned: enabledRows.length, disabled, clamped, dryRun };
  },
});
