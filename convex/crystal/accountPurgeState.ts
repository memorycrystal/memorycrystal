import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  emptyPrivateState,
  purgePrivateState,
  purgeProgress,
  type TargetState,
} from "./accountPurgeModel";
import { ACCOUNT_PURGE_TABLES, DATA_TABLES } from "./accountPurgeRegistry";

type Progress = Omit<
  Doc<"crystalAccountPurgeProgress">,
  "_id" | "_creationTime" | "runId"
>;
type Persisted = {
  run: Doc<"crystalAccountPurgeRuns">;
  progress: Doc<"crystalAccountPurgeProgress">;
  targets: Doc<"crystalAccountPurgeTargets">[];
};
export type Run = Omit<Doc<"crystalAccountPurgeRuns">, "targets"> &
  Progress & {
    targets: TargetState[];
    persisted: Persisted;
  };

/** Internal only. Indexed steps load one target's parents, not every target's history. */
export async function loadRun(
  ctx: QueryCtx,
  runId: Id<"crystalAccountPurgeRuns">,
  hydrate: "needed" | "all" | "none" = "needed",
): Promise<Run | null> {
  const run = await ctx.db.get(runId);
  if (!run) return null;
  const progress = await ctx.db
    .query("crystalAccountPurgeProgress")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
  if (!progress) throw new Error("progress_missing");
  const { _id, _creationTime, runId: _, ...position } = progress;
  const table = DATA_TABLES[progress.tableIndex];
  const shared =
    run.phase === "claim" ||
    (table &&
      (ACCOUNT_PURGE_TABLES[table].access.kind === "scan" ||
        table === "crystalAssociations"));
  const targetIndex =
    run.phase === "finalize"
      ? run.targets.findIndex((target) =>
          ["claimed", "deleting", "sweeping"].includes(target.state),
        )
      : progress.targetIndex;
  const targets: TargetState[] = [];
  const evidence: Doc<"crystalAccountPurgeTargets">[] = [];
  for (const [index, target] of run.targets.entries()) {
    if (
      hydrate === "none" ||
      (hydrate === "needed" && !shared && index !== targetIndex)
    ) {
      targets.push({ ...target, ...emptyPrivateState() });
      continue;
    }
    const child = await ctx.db
      .query("crystalAccountPurgeTargets")
      .withIndex("by_run_user", (q) =>
        q.eq("runId", runId).eq("userId", target.userId),
      )
      .unique();
    if (!child) throw new Error("evidence_missing");
    evidence.push(child);
    // Keep the original read immutable so saveRun can diff without reading again.
    const {
      _id,
      _creationTime,
      runId: _,
      ...privateState
    } = JSON.parse(JSON.stringify(child));
    targets.push({ ...target, ...privateState });
  }
  return {
    ...run,
    ...position,
    scanRowsRead: { ...position.scanRowsRead },
    targets,
    persisted: { run, progress, targets: evidence },
  };
}

function pick(source: object, fields: string[]) {
  return Object.fromEntries(
    fields
      .filter((key) => key in source)
      .map((key) => [key, (source as any)[key]]),
  );
}

async function patchChanged(
  ctx: MutationCtx,
  id: Id<any>,
  before: any,
  after: any,
) {
  const patch: Record<string, any> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key.startsWith("_") || key === "runId") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      patch[key] = after[key];
  }
  if (Object.keys(patch).length) await ctx.db.patch(id, patch);
}

/** Never rewrite captured parents for cursor movement or reread unchanged evidence. */
export async function saveRun(ctx: MutationCtx, run: Run) {
  const privateKeys = Object.keys(purgePrivateState);
  const progressKeys = Object.keys(purgeProgress);
  for (const child of run.persisted.targets) {
    const target = run.targets.find(
      (target) => target.userId === child.userId,
    )!;
    await patchChanged(
      ctx,
      child._id,
      pick(child, privateKeys),
      pick(target, privateKeys),
    );
  }
  const progress = run.persisted.progress;
  await patchChanged(
    ctx,
    progress._id,
    pick(progress, progressKeys),
    pick(run, progressKeys),
  );
  const stored = run.persisted.run;
  const state = pick(run, Object.keys(stored));
  state.targets = run.targets.map((target) =>
    Object.fromEntries(
      Object.entries(target).filter(([key]) => !privateKeys.includes(key)),
    ),
  );
  await patchChanged(ctx, run._id, stored, state);
}
