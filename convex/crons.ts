import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Emergency all-jobs pause. Online recovery can remove this flag while keeping
// only essential jobs and independently withholding destructive retention.
// These flags change registration at deployment, not already scheduled work.
if (process.env.CRYSTAL_MIGRATION_MODE !== "1") {
  // A bounded empty-scope search keeps both recall indexes warm during the
  // compatibility rollout; it remains enabled in essential-jobs-only mode.
  crons.interval(
    "memory-vector-index-keep-warm",
    { seconds: 60 },
    internal.crystal.memoryVectorAudit.keepMemoryVectorIndexesWarm,
    {},
  );

  // Explicit preservation gate; absent/invalid values never permit deletion.
  // Essential-only recovery overrides this flag if it was left set previously.
  if (
    process.env.CRYSTAL_RETENTION_READY === "1" &&
    process.env.CRYSTAL_ESSENTIAL_JOBS_ONLY !== "1"
  ) {
    crons.interval(
      "crystal-cleanup",
      { hours: 24 },
      internal.crystal.cleanup.runCleanup,
      {},
    );
    // Daily archived purge: bounded indexed seeks schedule only tenants with
    // archived sensory rows past their materialized tier retention deadline.
    // Durable LTM is excluded from recurring deletion; cascades include vectors.
    crons.interval(
      "crystal-archived-purge",
      { hours: 24 },
      internal.crystal.archivedPurge.purgeArchivedAllUsers,
      {},
    );
    crons.daily(
      "stm-expire",
      { hourUTC: 4, minuteUTC: 0 },
      internal.crystal.messages.expireOldMessages,
      {},
    );
  }

  // Daily TTL prune for bounded, aggregate-only operations telemetry.
  crons.daily(
    "crystal-function-metrics-ttl",
    { hourUTC: 6, minuteUTC: 0 },
    internal.crystal.observability.functionCallMetrics.pruneOldBuckets,
    { ttlDays: 7 },
  );

  // Recovery does not send lifecycle mail or mutate cloud infrastructure.
  if (process.env.CRYSTAL_ESSENTIAL_JOBS_ONLY !== "1") {


  }
  // ============ Tenant-Local ============

  crons.daily(
    "nightly-indexed-distillation",
    { hourUTC: 3, minuteUTC: 0 },
    internal.crystal.distillationQueue.nightlyIndexedDistillation,
    {},
  );
  // Indexed queue recovery/backoff only; never a scan of messages or profiles.
  crons.interval(
    "distillation-queue-recovery",
    { minutes: 1 },
    internal.crystal.distillationQueue.dispatch,
    {},
  );

}

export default crons;
