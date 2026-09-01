import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

// Migration targets must remain quiescent while a snapshot is imported and
// reconciled. Set CRYSTAL_MIGRATION_MODE=1 before deploying code to register no
// cron jobs, then remove it and redeploy after the target is promoted.
if (process.env.CRYSTAL_MIGRATION_MODE !== "1") {
  // ILL-183 — crystal-decay's 25-users-per-tick rotation is retired.
  // Forgetting runs inside crystal-reflection-cycle after Distillation,
  // every user every night, behind CRYSTAL_FORGETTING_ENFORCEMENT (default OFF).
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
  // ILL-180 / ILL-183 — nightly Reflection Cycle (Distillation, then Forgetting).
  // Visits EVERY user each run. Forgetting is wired but enforcement defaults OFF
  // (CRYSTAL_FORGETTING_ENFORCEMENT=1 to archive). Runs BEFORE stm-expire (04:00 UTC).
  crons.daily(
    "crystal-reflection-cycle",
    { hourUTC: 3, minuteUTC: 45 },
    internal.crystal.reflectionCycle.runReflectionCycle,
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
  //
  // DISABLED 2026-08-05 — it was burning network egress for nothing.
  //
  // On the Railway backend the reconcile cursor keeps resetting
  // (lastScannedCreationTime: 0, consecutiveZeroTicks: 0, ready: false), so
  // every ~6h burst re-reads the WHOLE crystalMemories table. At 92,279
  // memories x ~24 KB inline embedding that is ~2.1 GB per full pass, and
  // multiple passes per burst produced an 8.9 GB convex-postgres-prod egress
  // spike (~$38) on 2026-08-05 around 15:30 UTC.
  //
  // It buys nothing today: NO read path targets the side table. Every live
  // vectorSearch for memories still hits crystalMemories.by_embedding (recall,
  // mcp, knowledgeBases, consolidate, associations, writeDedupe, ltmHygiene,
  // organic/*), and EMBEDDING_TABLE_AS_PRIMARY exists only in comments — M9
  // Phase B (read switch) was never wired. New memories already get their
  // side-table row from dual-write (mcp.upsertEmbeddingTableRow, cleanup,
  // assets), so only the pre-dual-write backfill stops here.
  //
  // Re-enable when M9 Phase B is actually built, and fix the cursor reset
  // first — see convex/crystal/M9_CUTOVER.md. Coverage was verified 100% on
  // Convex Cloud (rightful-mockingbird-389), which is now PAUSED; the Railway
  // backend keeps its own reconcile state and was never the one verified.
  // crons.interval(
  //   "reconcileEmbeddingDualWrite",
  //   { minutes: 5 },
  //   internal.crystal.reconcileEmbeddingDualWrite.runReconcileTick,
  //   {},
  // );


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
