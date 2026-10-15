/**
 * M6 Telemetry Cron Declarations — LOCAL STACK ONLY
 *
 * !! DO NOT deploy this file as a standalone crons module. !!
 *
 * These cron declarations are intentionally separated from `convex/crons.ts`
 * because M2 and M5 are also touching that file in parallel. They must be
 * merged into `convex/crons.ts` during the M3 reconciliation step.
 *
 * ── M3 RECONCILIATION INSTRUCTIONS ──────────────────────────────────────────
 *
 *   Add the following two entries to `convex/crons.ts`:
 *
 *   ```ts
 *   import { internal } from "./_generated/api";
 *
 *   // M6 telemetry: compile + enqueue stats every 15 minutes
 *   crons.interval(
 *     "telemetry-tick",
 *     { minutes: 15 },
 *     internal.local.telemetryPush.tickTelemetry,
 *     {},
 *   );
 *
 *   // M6 telemetry: flush pending queue rows to cloud every 60 seconds
 *   crons.interval(
 *     "telemetry-flush",
 *     { seconds: 60 },
 *     internal.local.telemetryPush.flushTelemetry,
 *     {},
 *   );
 *   ```
 *
 *   Then delete this file (convex/local/telemetry-crons.ts).
 *
 * ── RATIONALE ────────────────────────────────────────────────────────────────
 *
 * Convex supports only one `cronJobs()` export per deployment (the default
 * export from `convex/crons.ts`). Multiple `cronJobs()` objects cannot be
 * merged at runtime; they must be combined into a single file. We export a
 * helper function `registerTelemetryCrons` that the eventual merged crons.ts
 * can call, keeping the declaration co-located with the feature code until
 * M3 cleans it up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { cronJobs } from "convex/server";
import { internal } from "../_generated/api";

/**
 * Register M6 telemetry crons onto an existing `CronJobs` instance.
 *
 * Usage in the merged `convex/crons.ts`:
 *
 *   ```ts
 *   import { registerTelemetryCrons } from "./local/telemetry-crons";
 *   const crons = cronJobs();
 *   // ... existing crons ...
 *   registerTelemetryCrons(crons);
 *   export default crons;
 *   ```
 */
export function registerTelemetryCrons(crons: ReturnType<typeof cronJobs>): void {
  // Cast to any: _generated/api.d.ts is stale until `npx convex dev` re-runs.
  // The local/ module references resolve correctly at Convex deploy time.
  const iLocal = (internal as any).local;

  // Compile stats + enqueue to localTelemetryQueue every 15 minutes
  crons.interval(
    "telemetry-tick",
    { minutes: 15 },
    iLocal.telemetryPush.tickTelemetry,
    {},
  );

  // Flush pending queue rows to cloud every 60 seconds
  crons.interval(
    "telemetry-flush",
    { seconds: 60 },
    iLocal.telemetryPush.flushTelemetry,
    {},
  );
}

/**
 * Standalone crons export — used only if this module is tested in isolation.
 * Do NOT export this as the default from convex/crons.ts; use
 * `registerTelemetryCrons` instead to compose into the main crons object.
 */
export const telemetryCrons = (() => {
  const c = cronJobs();
  registerTelemetryCrons(c);
  return c;
})();
