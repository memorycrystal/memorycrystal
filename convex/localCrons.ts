/**
 * Tenant-local crons (M5).
 *
 * Coordination note: M2 is editing `convex/crons.ts` in parallel for
 * cloud-side scheduled jobs. To avoid a write-time merge conflict the M5
 * bootstrap cron is registered here in a sibling file; an M3 follow-up
 * will fold it into the canonical `convex/crons.ts` once both branches
 * land. Convex picks up `cronJobs()` from any file that exports it as
 * default, so registering here is functionally equivalent.
 *
 * Cron contract:
 *   `bootstrapInitialFetch` runs every 30s. The action self-gates on the
 *   exponential-backoff schedule (5s → 1.5× → 300s cap, 1h budget) and
 *   short-circuits when `bootstrapState.state` is `"ready"` or `"expired"`.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const localCrons = cronJobs();

localCrons.interval(
  "bootstrapInitialFetch",
  { seconds: 30 },
  internal.local.bootstrap.fetchInitialState,
  {},
);

export default localCrons;
