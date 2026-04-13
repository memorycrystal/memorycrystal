import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("crystal-decay", { hours: 24 }, api.crystal.decay.applyDecay, {});
crons.interval("crystal-consolidate", { hours: 12 }, api.crystal.consolidate.runConsolidation, {});
crons.interval("crystal-cleanup", { hours: 24 }, internal.crystal.cleanup.runCleanup, {});
crons.interval("crystal-associate", { hours: 6 }, api.crystal.associations.buildAssociations, {});
crons.interval("stmEmbedder", { minutes: 15 }, api.crystal.stmEmbedder.embedUnprocessedMessages, {});
crons.interval("assetEmbedder", { minutes: 30 }, internal.crystal.assets.assetEmbedder, {});
crons.daily("stm-expire", { hourUTC: 4, minuteUTC: 0 }, internal.crystal.messages.expireOldMessages, {});
// Daily reflection: runs after stm-expire, distils recent memories via LLM for all users
crons.daily("crystal-reflect", { hourUTC: 4, minuteUTC: 30 }, api.crystal.reflection.runReflection, {});

// Graph enrichment backfill: process up to 25 unenriched memories every hour.
// Reduced from 200/5min to cut Gemini generateContent calls by ~96%.
crons.interval("crystal-graph-backfill", { hours: 1 }, api.crystal.graphEnrich.backfillGraphEnrichment, { maxMemories: 25 });

// Daily stats cache refresh: pre-warm telemetry for all users at 5:00 UTC
crons.daily("crystal-stats-cache", { hourUTC: 5, minuteUTC: 0 }, api.crystal.evalStats.refreshStatsCacheForAllUsers, {});

// Email lifecycle crons
crons.daily("trial-reminder", { hourUTC: 14, minuteUTC: 0 }, internal.crystal.emailCrons.checkTrialReminders, {});
crons.daily("trial-expired-check", { hourUTC: 14, minuteUTC: 30 }, internal.crystal.emailCrons.checkTrialExpired, {});
crons.daily("engagement-check", { hourUTC: 16, minuteUTC: 0 }, internal.crystal.emailCrons.checkEngagement, {});

// Organic Memory tick loop: minute cadence so per-user intervals can range from 1 minute to 24 hours.
crons.interval("organic-memory-tick", { minutes: 1 }, internal.crystal.organic.tick.runTick, {});

// Organic Memory trace pruning: hard-delete validated/expired traces older than 30 days
crons.daily("organic-trace-prune", { hourUTC: 3, minuteUTC: 0 }, internal.crystal.organic.traces.pruneExpiredTraces, {});

// Organic Memory activity log pruning: delete entries older than 7 days
crons.weekly("organic-activity-prune", { dayOfWeek: "sunday", hourUTC: 4, minuteUTC: 0 },
  internal.crystal.organic.activityLog.pruneActivityLog, {}
);
// Organic idea digest: check for pending ideas and send email notifications
crons.interval("organic-idea-digest", { hours: 1 }, internal.crystal.organic.ideaDigest.sendIdeaDigestEmails, {});

export default crons;
