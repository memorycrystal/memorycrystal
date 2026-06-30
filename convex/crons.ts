import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("crystal-decay", { hours: 24 }, api.crystal.decay.applyDecay, {});
crons.interval("crystal-consolidate", { hours: 12 }, api.crystal.consolidate.runConsolidation, {});
crons.interval("crystal-cleanup", { hours: 24 }, internal.crystal.cleanup.runCleanup, {});
// Daily archived purge: hard-deletes spent archived rows so they stop bloating
// the recall vector scan — sensory >7d, non-sensory >30d (keeping supersession
// predecessors). Cascade-safe incl. the M8 embedding sidecar. Fans out one
// scheduled action per user; per-store scan early-terminates on createdAt.
crons.interval("crystal-archived-purge", { hours: 24 }, internal.crystal.archivedPurge.purgeArchivedAllUsers, {});
crons.interval("crystal-associate", { hours: 6 }, api.crystal.associations.buildAssociations, {});
crons.interval("stmEmbedder", { minutes: 15 }, api.crystal.stmEmbedder.embedUnprocessedMessages, {});
crons.interval("assetEmbedder", { minutes: 30 }, internal.crystal.assets.assetEmbedder, {});
crons.daily("stm-expire", { hourUTC: 4, minuteUTC: 0 }, internal.crystal.messages.expireOldMessages, {});
// Daily reflection: runs after stm-expire, distils recent memories via LLM for all users
crons.daily("crystal-reflect", { hourUTC: 4, minuteUTC: 30 }, api.crystal.reflection.runReflection, {});

// Graph enrichment backfill: hourly, with per-user success caps resolved inside the action.
// Users can raise their own cap only when they have a personal OpenRouter key.
crons.interval("crystal-graph-backfill", { hours: 1 }, api.crystal.graphEnrich.backfillGraphEnrichment, {});

// M0 — Daily TTL prune: delete crystalFunctionCallMetrics rows older than 30 days.
// Offset from crystal-stats-cache (05:00) and crystal-reflect (04:30) to avoid contention.
crons.daily("crystal-function-metrics-ttl", { hourUTC: 6, minuteUTC: 0 }, internal.crystal.observability.functionCallMetrics.pruneOldBuckets, { ttlDays: 30 });

// M7.5 — Daily stats cache refresh: now reads crystalDashboardTotals aggregate (O(N) reads)
// instead of the old O(N×M) paginated memory scan. Legacy users without an aggregate row
// still get a full rebuild on first hit, then are served from the aggregate thereafter.
crons.daily("crystal-stats-cache", { hourUTC: 5, minuteUTC: 0 }, api.crystal.evalStats.refreshStatsCacheForAllUsers, {});

// Exact recent recall/retrieval summary for Telemetry. Runs as a backend rollup
// so the dashboard can show complete counts without live client-side scans.
crons.daily("crystal-recall-summary-cache", { hourUTC: 5, minuteUTC: 20 }, api.crystal.evalStats.refreshRecallSummaryCacheForAllUsers, {});

// M7.5 — Weekly drift check: spot-checks 1 user/week by running source-of-truth recompute
// and comparing against the stored aggregate. Rebuilds if divergence exceeds 5%.
crons.weekly("crystal-stats-drift-check", { dayOfWeek: "sunday", hourUTC: 5, minuteUTC: 30 },
  internal.crystal.evalStats.refreshStatsDriftCheck, {}
);

// Email lifecycle crons
crons.daily("trial-reminder", { hourUTC: 14, minuteUTC: 0 }, internal.crystal.emailCrons.checkTrialReminders, {});
crons.daily("trial-expired-check", { hourUTC: 14, minuteUTC: 30 }, internal.crystal.emailCrons.checkTrialExpired, {});
crons.daily("engagement-check", { hourUTC: 16, minuteUTC: 0 }, internal.crystal.emailCrons.checkEngagement, {});

// Organic Memory tick loop: minute cadence so per-user intervals can range from 1 minute to 24 hours.
crons.interval("organic-memory-tick", { minutes: 1 }, internal.crystal.organic.tick.runTick, {});

// Organic Memory trace pruning: hard-delete validated/expired traces older than 30 days
crons.daily("organic-trace-prune", { hourUTC: 3, minuteUTC: 0 }, internal.crystal.organic.traces.pruneExpiredTraces, {});

// Organic Memory activity log pruning: keep recall telemetry for the 6-month dashboard range
crons.weekly("organic-activity-prune", { dayOfWeek: "sunday", hourUTC: 4, minuteUTC: 0 },
  internal.crystal.organic.activityLog.pruneActivityLog, {}
);
// Organic idea digest: check for pending ideas and send email notifications
crons.interval("organic-idea-digest", { hours: 1 }, internal.crystal.organic.ideaDigest.sendIdeaDigestEmails, {});

// M8 — Embedding dual-write reconcile: copies inline embeddings to
// crystalMemoryEmbeddings for memories that were written before dual-write
// was enabled. Runs every 30 min; self-backs-off to 60-min window on zero rows.
// Cast through `any` until `convex dev` regenerates the API with the new module.
crons.interval(
  "reconcileEmbeddingDualWrite",
  { minutes: 30 },
  internal.crystal.reconcileEmbeddingDualWrite.runReconcileTick,
  {},
);


export default crons;
