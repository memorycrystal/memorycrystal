import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

// Migration targets must remain quiescent while a snapshot is imported and
// reconciled. Set CRYSTAL_MIGRATION_MODE=1 before deploying code to register no
// cron jobs, then remove it and redeploy after the target is promoted.
if (process.env.CRYSTAL_MIGRATION_MODE !== "1") {
  crons.interval(
    "crystal-decay",
    { hours: 24 },
    api.crystal.decay.applyDecay,
    {},
  );
  crons.interval(
    "crystal-consolidate",
    { hours: 12 },
    api.crystal.consolidate.runConsolidation,
    {},
  );
  crons.interval(
    "crystal-cleanup",
    { hours: 24 },
    internal.crystal.cleanup.runCleanup,
    {},
  );
  // Daily archived purge: hard-deletes spent archived rows so they stop bloating
  // the recall vector scan — sensory >7d, non-sensory >30d (keeping supersession
  // predecessors). Cascade-safe incl. the M8 embedding sidecar. Fans out one
  // scheduled action per user; per-store scan early-terminates on createdAt.
  crons.interval(
    "crystal-archived-purge",
    { hours: 24 },
    internal.crystal.archivedPurge.purgeArchivedAllUsers,
    {},
  );
  crons.interval(
    "crystal-associate",
    { hours: 6 },
    api.crystal.associations.buildAssociations,
    {},
  );
  crons.interval(
    "stmEmbedder",
    { minutes: 15 },
    api.crystal.stmEmbedder.embedUnprocessedMessages,
    {},
  );
  crons.interval(
    "assetEmbedder",
    { minutes: 30 },
    internal.crystal.assets.assetEmbedder,
    {},
  );
  crons.daily(
    "stm-expire",
    { hourUTC: 4, minuteUTC: 0 },
    internal.crystal.messages.expireOldMessages,
    {},
  );
  // Retry sweep for messages queued but not yet retired (transient LTM failures /
  // never-terminal skips). Indexed seek of stale-queued rows only; force-retires
  // at MAX_RETIREMENT_ATTEMPTS so stuck messages drain instead of churning.
  // Hourly to match RETIREMENT_RETRY_AFTER_MS (1h): a stuck message advances one
  // attempt per hour, so it force-drains in ~MAX_RETIREMENT_ATTEMPTS hours rather
  // than days. Each pass is a bounded indexed seek, so this is cheap.
  crons.interval(
    "stm-retry-retirement",
    { hours: 1 },
    internal.crystal.messages.retryStuckRetirements,
    {},
  );

  // Proactive LTM extraction catch-up: consolidate un-extracted conversation
  // messages into recallable memories WITHOUT waiting for TTL expiry/retirement.
  // DISABLED 2026-07-02 (cross-tenant recall leak incident): this mass-extracted
  // conversation content (incl. peer/dev-session channels) into the recall pool,
  // amplifying a cross-channel visibility gap. Re-enable ONLY after non-KB memory
  // channel isolation is hardened and extraction channel-tagging is verified.
  // crons.interval(
  //   "ltm-extraction-catchup",
  //   { hours: 1 },
  //   internal.crystal.ltmExtraction.runLtmExtractionCatchup,
  //   { usersLimit: 15, messagesPerUser: 40 },
  // );
  // Gated proactive message distillation. The action defaults OFF, requires an
  // explicit pilot allowlist, rejects ambiguous channels, and applies bounded
  // per-user message caps before reusing the on-demand extraction path.
  crons.daily(
    "proactive-ltm-distillation",
    { hourUTC: 5, minuteUTC: 15 },
    internal.crystal.ltmExtraction.runProactiveMessageDistillation,
    {},
  );
  // Daily reflection: runs after stm-expire, distils recent memories via LLM for all users
  crons.daily(
    "crystal-reflect",
    { hourUTC: 4, minuteUTC: 30 },
    api.crystal.reflection.runReflection,
    {},
  );

  // Graph enrichment backfill: hourly, with per-user success caps resolved inside the action.
  // Users can raise their own cap only when they have a personal OpenRouter key.
  crons.interval(
    "crystal-graph-backfill",
    { hours: 1 },
    api.crystal.graphEnrich.backfillGraphEnrichment,
    {},
  );

  // M0 — Daily TTL prune: delete crystalFunctionCallMetrics rows older than 30 days.
  // Offset from crystal-stats-cache (05:00) and crystal-reflect (04:30) to avoid contention.
  crons.daily(
    "crystal-function-metrics-ttl",
    { hourUTC: 6, minuteUTC: 0 },
    internal.crystal.observability.functionCallMetrics.pruneOldBuckets,
    { ttlDays: 30 },
  );





  // Organic Memory tick loop: minute cadence so per-user intervals can range from 1 minute to 24 hours.
  crons.interval(
    "organic-memory-tick",
    { minutes: 1 },
    internal.crystal.organic.tick.runTick,
    {},
  );

  // Organic Memory trace pruning: hard-delete validated/expired traces older than 30 days
  crons.daily(
    "organic-trace-prune",
    { hourUTC: 3, minuteUTC: 0 },
    internal.crystal.organic.traces.pruneExpiredTraces,
    {},
  );

  // Organic Memory activity log pruning: keep recall telemetry for the 6-month dashboard range
  crons.weekly(
    "organic-activity-prune",
    { dayOfWeek: "sunday", hourUTC: 4, minuteUTC: 0 },
    internal.crystal.organic.activityLog.pruneActivityLog,
    {},
  );
  // Organic idea digest: check for pending ideas and send email notifications
  crons.interval(
    "organic-idea-digest",
    { hours: 1 },
    internal.crystal.organic.ideaDigest.sendIdeaDigestEmails,
    {},
  );

  // Wave 2 — lazy recallText backfill: compress old memories still missing a
  // compact recallText in small bounded, idempotent batches over time. No
  // synchronous mass migration; deterministic + safe to re-run. Rotates across a
  // slice of users each hour.
  crons.interval(
    "organic-recall-compression-backfill",
    { hours: 1 },
    internal.crystal.organic.recallCompressionBackfill
      .runRecallCompressionBackfill,
    {},
  );


  // M8 — Embedding dual-write reconcile: copies inline embeddings to
  // crystalMemoryEmbeddings for memories that were written before dual-write
  // was enabled. Runs every 5 min while a pass is crawling (each active tick
  // drains up to 20 pages); rests 6h between full passes and weekly once the
  // clean-pass cutover gate is green (see reconcileEmbeddingDualWrite.ts).
  crons.interval(
    "reconcileEmbeddingDualWrite",
    { minutes: 5 },
    internal.crystal.reconcileEmbeddingDualWrite.runReconcileTick,
    {},
  );


  // ILL-107 — hygiene lints. Low-frequency, all-users, advisory (read-only
  // w.r.t. memories; they emit organicIdeas, never archive/delete). Weekly to
  // keep the added load negligible at 33k scale.
  crons.interval(
    "crystal-graph-lint",
    { hours: 24 * 7 },
    internal.crystal.hygieneWorklist.runGraphLintForAllUsers,
    {},
  );
  crons.interval(
    "crystal-concept-gap-scan",
    { hours: 24 * 7 },
    internal.crystal.hygieneWorklist.runConceptGapScanForAllUsers,
    {},
  );

  // ILL-108 G3 — daily overnight brief: one read-only "here's what your memory
  // did overnight" idea per active user. Advisory (emits organicIdeas only).
  crons.interval(
    "crystal-overnight-brief",
    { hours: 24 },
    internal.crystal.dailyDriver.emitOvernightBriefForAllUsers,
    {},
  );
}

export default crons;
