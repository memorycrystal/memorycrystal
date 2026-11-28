import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  AUTH_TABLES,
  DATA_TABLES,
  PURGE_TABLE_NAMES,
  ACCOUNT_PURGE_TABLES,
  type PurgeTable,
} from "./accountPurgeRegistry";
import {
  GUARD_SOURCES,
  boundedIntegrityContext,
  dependencyOwners,
  claimComponents,
  inspectComponent,
  projectGuardRow,
  scanDependencies,
  applyDependencyPage,
} from "./accountPurgeGuards";
import {
  deleteMemoryOwned,
  deleteOwned,
  deleteVectorOwned,
  inspectFiles,
  isOwned,
  userIdentifierHashes,
  type DeletionContext,
} from "./accountPurgeOwnership";
import {
  emptyPrivateState,
  MAX_BYTES,
  MAX_DELETIONS,
  MAX_PARENTS,
  PAGE_SIZE,
  purgeOptions,
  purgeParents,
  purgeTarget,
  validateOptions,
  type Parents,
  type TargetState,
} from "./accountPurgeModel";
import { loadRun, saveRun, type Run } from "./accountPurgeState";
import { readReport } from "./accountPurgeReports";
import { purgeReadContext } from "./accountPurgeReads";
import { assertKeysSafeToDeleteWithRotations } from "./apiKeyRotationIntegrity";
export { ACCOUNT_PURGE_TABLES } from "./accountPurgeRegistry";
export { deleteOwned } from "./accountPurgeOwnership";

const api = (internal as any).crystal.accountPurge;
const live = (target: TargetState) =>
  ["claimed", "deleting", "sweeping"].includes(target.state);
const targetView = v.object({ userId: v.id("users"), parents: purgeParents });
type View = { userId: string; parents: Parents };

function parentValues(table: PurgeTable, target: View) {
  const rule = ACCOUNT_PURGE_TABLES[table].rule;
  if (rule.kind !== "parent") return [];
  return target.parents[rule.parent];
}

function pageQuery(
  ctx: QueryCtx,
  table: PurgeTable,
  target?: View,
  parentIndex = 0,
  nullOwners = false,
): any {
  const entry = ACCOUNT_PURGE_TABLES[table];
  let query: any = ctx.db.query(table);
  if (entry.access.kind === "index" && (target || nullOwners)) {
    const value = nullOwners
      ? undefined
      : entry.rule.kind === "rate"
        ? `acct:${target!.userId}`
        : target!.userId;
    const field = entry.access.field;
    query = query.withIndex(entry.access.index, (q: any) => q.eq(field, value));
  } else if (
    entry.rule.kind === "parent" &&
    entry.access.kind === "parent" &&
    entry.access.index &&
    target
  ) {
    const field = entry.rule.field;
    query = query.withIndex(entry.access.index, (q: any) =>
      q.eq(field, parentValues(table, target)[parentIndex]),
    );
  } else if (entry.rule.kind === "self" && target) {
    query = query.withIndex("by_id", (q: any) => q.eq("_id", target.userId));
  }
  return query;
}

export const guardPage = internalQuery({
  args: {
    target: purgeTarget,
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    ctx = purgeReadContext(ctx);
    const source = GUARD_SOURCES.find((source) => source[0] === args.table);
    if (!source) throw new Error("invalid_guard_source");
    const page = await (ctx.db.query(source[0]) as any)
      .withIndex(source[1], (q: any) => q.eq(source[2], args.target.userId))
      .paginate({
        cursor: args.cursor,
        numItems: PAGE_SIZE,
        maximumBytesRead: MAX_BYTES,
      });
    const rows = [];
    for (const row of page.page)
      rows.push(await projectGuardRow(ctx, args.table, row));
    return { rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Same bounded live inspection as the atomic claim, with no private identifiers in results. */
export const inspectPlanComponent = internalQuery({
  args: {
    ...purgeOptions,
    target: purgeTarget,
    rateLimitPeers: v.array(purgeTarget),
    removedCredentials: v.array(v.string()),
    dependencyStartedAt: v.number(),
    scans: v.record(
      v.string(),
      v.object({
        dependencyPeers: v.optional(v.array(v.string())),
        dependencyRefusal: v.optional(v.string()),
        dependenciesComplete: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    ctx = purgeReadContext(ctx);
    const component = (await claimComponents(ctx, args.targets)).find((group) =>
      group.targets.some((target) => target.userId === args.target.userId),
    )!;
    const checks = await inspectComponent(ctx, component, {
      options: args,
      earlierPeers: args.rateLimitPeers,
      removedCredentials: args.removedCredentials,
      dependencyStartedAt: args.dependencyStartedAt,
      scans: args.scans,
    });
    return Promise.all(
      checks.map(async (check) => ({
        userId: check.userId,
        eligible: check.eligible,
        evidence: check.evidence,
        parents: check.eligible
          ? await withHistoricalParents(ctx, check.userId, check.parents)
          : check.parents,
        claimedRateLimits: check.eligible
          ? (check.snapshot.authRateLimits ?? []).map((row) => row._id)
          : [],
        removedCredentials: check.eligible
          ? ["authAccounts", "authRateLimits"].flatMap((table) =>
              (check.snapshot[table] ?? []).map((row) => row._id),
            )
          : [],
      })),
    );
  },
});

async function exemptReferences(
  ctx: QueryCtx,
  table: PurgeTable,
  row: any,
  userId: string,
) {
  if (
    ACCOUNT_PURGE_TABLES[table].references.some((field) =>
      field === "targets.userId"
        ? row.targets?.some((target: any) => target.userId === userId)
        : row[field] === userId,
    )
  )
    return true;
  if (!row.tenantId || !PURGE_TABLE_NAMES.includes("tenants" as PurgeTable))
    return false;
  const id = ctx.db.normalizeId("tenants" as any, row.tenantId);
  const parent: any = id ? await ctx.db.get(id) : null;
  return parent?.userId === userId;
}

/** Hashes retain verification provenance after the users row is gone. */
async function identifierHashesFor(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  const evidence = await ctx.db
    .query("crystalAccountPurgeTargets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PARENTS + 1);
  if (evidence.length > MAX_PARENTS) throw new Error("evidence_budget");
  return [
    ...new Set([
      ...(await userIdentifierHashes(user)),
      ...evidence.flatMap((row) => row.identifierHashes),
    ]),
  ];
}

/** One bounded page. Counts only; no customer document content or raw identifier leaves this query. */
export const countPage = internalQuery({
  args: {
    table: v.string(),
    targets: v.array(targetView),
    peers: v.array(targetView),
    cursor: v.union(v.string(), v.null()),
    parentIndex: v.number(),
    nullOwners: v.boolean(),
    claimedRateLimits: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    ctx = purgeReadContext(ctx);
    if (!PURGE_TABLE_NAMES.includes(args.table as PurgeTable))
      throw new Error("invalid_table");
    const table = args.table as PurgeTable;
    const targets = args.targets.map((target) => ({
      ...target,
      identifierHashes: [] as string[],
      rateLimitIdentifiersShared: 0,
      sharedRateLimitIds: [] as string[],
      peers: args.peers,
    }));
    if (table === "authRateLimits") {
      for (const target of targets)
        target.identifierHashes = await identifierHashesFor(ctx, target.userId);
    }
    const entry = ACCOUNT_PURGE_TABLES[table];
    const parentCount =
      entry.rule.kind === "parent" && entry.access.kind === "parent"
        ? parentValues(table, targets[0]).length
        : 1;
    const counts: Record<string, number> = {};
    const files: Record<
      string,
      {
        filesSkippedInvalidKey: number;
        filesAlreadyMissing: number;
        rateLimitIdentifiersShared: number;
      }
    > = {};
    for (const target of targets) {
      counts[target.userId] = 0;
      files[target.userId] = {
        filesSkippedInvalidKey: 0,
        filesAlreadyMissing: 0,
        rateLimitIdentifiersShared: 0,
      };
    }
    if (args.parentIndex >= parentCount)
      return {
        counts,
        files,
        rowsRead: 0,
        parentCount,
        isDone: true,
        continueCursor: "",
      };
    const page = await pageQuery(
      ctx,
      table,
      targets.length === 1 ? targets[0] : undefined,
      args.parentIndex,
      args.nullOwners,
    ).paginate({
      cursor: args.cursor,
      numItems: PAGE_SIZE,
      maximumBytesRead: MAX_BYTES,
    });
    for (const row of page.page) {
      // A shared identifier can first be deleted by its last claimant. Count it once.
      for (const target of table === "authRateLimits"
        ? [...targets].reverse()
        : targets) {
        const claimant = args.claimedRateLimits?.[row._id];
        const owned =
          claimant !== undefined
            ? claimant === target.userId
            : entry.rule.kind === "exempt"
              ? await exemptReferences(ctx, table, row, target.userId)
              : await isOwned(ctx, table, row, target);
        files[target.userId].rateLimitIdentifiersShared =
          target.rateLimitIdentifiersShared;
        if (!owned) continue;
        counts[target.userId]++;
        const status = await inspectFiles(ctx, table, row);
        files[target.userId].filesSkippedInvalidKey +=
          status.filesSkippedInvalidKey;
        files[target.userId].filesAlreadyMissing += status.filesAlreadyMissing;
        if (table === "authRateLimits") break;
      }
    }
    return {
      counts,
      files,
      rowsRead: page.page.length,
      parentCount,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const dependencyPage = internalQuery({
  args: {
    target: purgeTarget,
    targets: v.array(purgeTarget),
    sourceIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.sourceIndex !== 0 && args.sourceIndex !== 1)
      throw new Error("invalid_dependency_source");
    return scanDependencies(
      purgeReadContext(ctx),
      args.target,
      args.targets,
      args.sourceIndex,
      args.cursor,
    );
  },
});

export const planAccountPurge = internalAction({
  args: { ...purgeOptions, cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    validateOptions(args);
    return readReport(ctx, "plan", args);
  },
});

async function schedule(ctx: MutationCtx, run: Run) {
  run.generation++;
  run.updatedAt = Date.now();
  await saveRun(ctx, run);
  if (run.status === "running")
    await ctx.scheduler.runAfter(0, api.stepAccountPurge, {
      runId: run._id,
      generation: run.generation,
    });
}

export const startAccountPurge = internalMutation({
  args: { ...purgeOptions, confirm: v.literal("DELETE") },
  handler: async (ctx, args) => {
    validateOptions(args);
    const active = await ctx.db
      .query("crystalAccountPurgeRuns")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(101);
    if (
      active.length > 100 ||
      active.some((run) =>
        run.targets.some(
          (target) =>
            !["done", "stopped", "refused"].includes(target.state) &&
            args.targets.some(
              (candidate) => candidate.userId === target.userId,
            ),
        ),
      )
    )
      throw new Error("target_busy");
    const now = Date.now();
    const runId = await ctx.db.insert("crystalAccountPurgeRuns", {
      targets: args.targets.map((target) => ({
        ...target,
        state: "pending" as const,
      })),
      inactiveDays: args.inactiveDays ?? 30,
      force: args.force ?? [],
      polarCancelled: args.polarCancelled ?? [],
      status: "running",
      phase: "dependencies",
      dependencyStartedAt: now,
      generation: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("crystalAccountPurgeProgress", {
      runId,
      tableIndex: 0,
      targetIndex: 0,
      parentIndex: 0,
      cursor: null,
      scanRowsRead: {},
    });
    for (const target of args.targets)
      await ctx.db.insert("crystalAccountPurgeTargets", {
        runId,
        userId: target.userId,
        ...emptyPrivateState(),
      });
    await ctx.scheduler.runAfter(0, api.stepAccountPurge, {
      runId,
      generation: 0,
    });
    return { runId };
  },
});

async function withHistoricalParents(
  ctx: QueryCtx,
  userId: Id<"users">,
  parents: Parents,
): Promise<Parents> {
  const history = await ctx.db
    .query("crystalAccountPurgeTargets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PARENTS + 1);
  if (history.length > MAX_PARENTS) throw new Error("parent_budget");
  const merged = { ...parents };
  for (const key of ["sessions", "accounts", "memories"] as const) {
    merged[key] = [
      ...new Set([
        ...parents[key],
        ...history.flatMap((row) => row.parents[key]),
      ]),
    ];
    if (merged[key].length > MAX_PARENTS) throw new Error("parent_budget");
  }
  return merged;
}

async function claim(ctx: MutationCtx, run: Run, first: TargetState) {
  const component = (await claimComponents(ctx, run.targets)).find((group) =>
    group.targets.some((target) => target.userId === first.userId),
  )!;
  const checks = await inspectComponent(ctx, component, {
    options: run,
    earlierPeers: run.targets.filter(live),
    dependencyStartedAt: run.dependencyStartedAt ?? 0,
    scans: Object.fromEntries(
      run.targets.map((target) => [target.userId, target]),
    ),
  });
  // A newly linked non-pending peer cannot participate in an atomic new claim.
  const unavailable = component.targets.some(
    (member) =>
      run.targets.find((target) => target.userId === member.userId)!.state !==
      "pending",
  );
  if (checks.some((check) => !check.eligible) || unavailable) {
    for (const check of checks) {
      const target = run.targets.find(
        (target) => target.userId === check.userId,
      )!;
      if (target.state !== "pending") continue;
      if (unavailable && !check.evidence.refusals.length)
        check.evidence.refusals.push("G7_dependent");
      target.evidence = check.evidence;
      target.state = "refused";
      target.reason = check.evidence.refusals[0];
    }
    return;
  }
  let deleted = 0;
  const claimed: TargetState[] = [];
  for (const check of checks) {
    const target = run.targets.find(
      (target) => target.userId === check.userId,
    )!;
    target.evidence = check.evidence;
    // Carry private provenance from an abandoned predecessor for late children.
    target.parents = await withHistoricalParents(
      ctx,
      target.userId,
      check.parents,
    );
    target.identifierHashes = await identifierHashesFor(ctx, target.userId);
    const peers = run.targets.filter(
      (peer) => live(peer) || claimed.includes(peer) || peer === target,
    );
    const deletion: DeletionContext = {
      ctx,
      runId: run._id,
      target: { ...target, peers },
      deleted,
    };
    for (const table of AUTH_TABLES)
      for (const row of check.snapshot[table] ?? [])
        await deleteOwned(deletion, table, row._id);
    deleted = deletion.deleted;
    const { peers: _, ...updated } = deletion.target;
    Object.assign(target, updated);
    claimed.push(target);
  }
  // The enclosing mutation commits revocations and every state transition together.
  for (const target of claimed) target.state = "claimed";
}

function advanceTable(run: Run) {
  run.tableIndex++;
  run.targetIndex = 0;
  run.parentIndex = 0;
  run.cursor = null;
  run.table = DATA_TABLES[run.tableIndex];
}

async function deleteDataRow(
  deletion: DeletionContext,
  table: PurgeTable,
  row: any,
) {
  if (table === "crystalMemories") return deleteMemoryOwned(deletion, row);
  if (table === "crystalMemoryEmbeddings")
    return deleteVectorOwned(deletion, row._id);
  if (table === "crystalApiKeys" || table === "crystalApiKeyRotations") {
    const keys = await deletion.ctx.db
      .query("crystalApiKeys")
      .withIndex("by_user", (q) => q.eq("userId", deletion.target.userId))
      .take(MAX_DELETIONS + 1);
    const rotations = await deletion.ctx.db
      .query("crystalApiKeyRotations")
      .withIndex("by_user_label", (q) => q.eq("userId", deletion.target.userId))
      .take(MAX_DELETIONS + 1);
    if (keys.length + rotations.length + deletion.deleted > MAX_DELETIONS)
      throw new Error("credential_budget");
    await assertKeysSafeToDeleteWithRotations(
      boundedIntegrityContext(deletion.ctx),
      { ownerUserId: deletion.target.userId, keys, ownedRotations: rotations },
    );
    for (const rotation of rotations)
      await deleteOwned(deletion, "crystalApiKeyRotations", rotation._id);
    for (const key of keys)
      await deleteOwned(deletion, "crystalApiKeys", key._id);
    return;
  }
  await deleteOwned(deletion, table, row._id);
}

// Never persist an exception message: storage/provider errors can contain private data.
const errorCodes = new Set([
  "claim_budget",
  "credential_budget",
  "deletion_budget",
  "vector_budget",
  "duplicate_vectors",
  "parent_budget",
  "external_file_after_claim",
  "vector_owner_changed",
]);
function errorCode(error: unknown) {
  return error instanceof Error && errorCodes.has(error.message)
    ? error.message
    : "unexpected_error";
}
async function forTarget(target: TargetState, work: () => Promise<void>) {
  try {
    await work();
    target.consecutiveFailures = 0;
  } catch (error) {
    throw new ConvexError({ userId: target.userId, code: errorCode(error) });
  }
}

/** Stop null-linked peers if a proposed peer failed its claim. No activity signals are reread. */
async function checkClaimedPeers(ctx: QueryCtx, run: Run) {
  let changed: boolean;
  do {
    changed = false;
    const ids = run.targets.filter(live).map((target) => target.userId);
    for (const target of run.targets.filter(live)) {
      for (const memoryId of target.parents.memories) {
        for (const [index, field] of [
          ["by_purge_from", "fromMemoryId"],
          ["by_purge_to", "toMemoryId"],
        ] as const) {
          const rows = await ctx.db
            .query("crystalAssociations")
            .withIndex(index, (q) =>
              q.eq(field, memoryId as Id<"crystalMemories">),
            )
            .take(MAX_PARENTS + 1);
          if (
            rows.length > MAX_PARENTS ||
            (
              await Promise.all(
                rows.map((row) =>
                  dependencyOwners(ctx, "crystalAssociations", row, ids),
                ),
              )
            ).some((owners) => owners.includes(target.userId))
          ) {
            target.state = "stopped";
            target.reason = "G7_dependent";
            changed = true;
          }
        }
      }
    }
  } while (changed);
}

/** Nested mutation is a savepoint: a failure rolls back data, files, logs and cursor together. */
export const executeAccountPurgeStep = internalMutation({
  args: { runId: v.id("crystalAccountPurgeRuns"), generation: v.number() },
  handler: async (ctx, args) => {
    ctx = purgeReadContext(ctx);
    const run = await loadRun(ctx, args.runId);
    if (!run || run.status !== "running" || run.generation !== args.generation)
      return;
    if (run.phase === "dependencies") {
      const target = run.targets[run.targetIndex];
      if (!target) {
        run.phase = "claim";
        run.targetIndex = 0;
        run.parentIndex = 0;
        run.cursor = null;
      } else if (target.state !== "pending") {
        run.targetIndex++;
        run.parentIndex = 0;
        run.cursor = null;
      } else {
        await forTarget(target, async () => {
          const page = await scanDependencies(
            ctx,
            target,
            run.targets,
            run.parentIndex,
            run.cursor,
          );
          const next = applyDependencyPage(target, page, run.parentIndex);
          run.parentIndex = next.sourceIndex;
          run.cursor = next.cursor;
          if (next.complete) run.targetIndex++;
        });
      }
      await schedule(ctx, run);
      return;
    }
    if (run.phase === "claim") {
      const target = run.targets[run.targetIndex];
      if (target) {
        if (target.state === "pending")
          await forTarget(target, () => claim(ctx, run, target));
        run.targetIndex++;
      } else {
        await checkClaimedPeers(ctx, run);
        run.phase = "data";
        run.targetIndex = 0;
        for (const target of run.targets)
          if (live(target)) target.state = "deleting";
      }
      await schedule(ctx, run);
      return;
    }
    if (!run.targets.some(live)) {
      run.status = "complete";
      run.phase = "complete";
      await schedule(ctx, run);
      return;
    }
    if (run.phase === "finalize") {
      const target = run.targets.find(live)!;
      await forTarget(target, async () => {
        const deletion: DeletionContext = {
          ctx,
          runId: run._id,
          target,
          deleted: 0,
        };
        const profiles = await ctx.db
          .query("crystalUserProfiles")
          .withIndex("by_user", (q) => q.eq("userId", target.userId))
          .take(MAX_DELETIONS);
        if (profiles.length >= MAX_DELETIONS) {
          target.state = "stopped";
          target.reason = "writer_active";
        } else {
          await deleteOwned(deletion, "users", target.userId);
          for (const profile of profiles)
            await deleteOwned(deletion, "crystalUserProfiles", profile._id);
          target.state = "done";
        }
      });
      await schedule(ctx, run);
      return;
    }
    const table = DATA_TABLES[run.tableIndex];
    if (!table) {
      run.phase =
        run.phase === "data"
          ? "sweep"
          : run.phase === "sweep"
            ? "verify"
            : "finalize";
      run.tableIndex = -1;
      advanceTable(run);
      for (const target of run.targets)
        if (live(target)) target.state = "sweeping";
      await schedule(ctx, run);
      return;
    }
    run.table = table;
    const entry = ACCOUNT_PURGE_TABLES[table];
    // The undefined-user index partition is visited once for the entire batch.
    const nullOwners =
      table === "crystalAssociations" && run.targetIndex === run.targets.length;
    const scan = entry.access.kind === "scan" || nullOwners;
    const target = scan ? undefined : run.targets[run.targetIndex];
    if (!scan && (!target || !live(target))) {
      if (!target) advanceTable(run);
      else {
        run.targetIndex++;
        run.parentIndex = 0;
        run.cursor = null;
      }
      await schedule(ctx, run);
      return;
    }
    if (
      entry.access.kind === "parent" &&
      target &&
      run.parentIndex >= parentValues(table, target).length
    ) {
      run.targetIndex++;
      run.parentIndex = 0;
      run.cursor = null;
      await schedule(ctx, run);
      return;
    }
    const one = [
      "crystalMemories",
      "crystalMemoryEmbeddings",
      "crystalApiKeys",
      "crystalApiKeyRotations",
    ].includes(table);
    const page = await pageQuery(
      ctx,
      table,
      target,
      run.parentIndex,
      nullOwners,
    ).paginate({
      cursor: run.cursor,
      numItems: one ? 1 : PAGE_SIZE,
      maximumBytesRead: MAX_BYTES,
    });
    if (scan)
      run.scanRowsRead[table] =
        (run.scanRowsRead[table] ?? 0) + page.page.length;
    let deleted = 0;
    const owners = target ? [target] : run.targets.filter(live);
    // Keep late-row attribution consistent with claims and the read-only plan.
    for (const owner of table === "authRateLimits"
      ? [...owners].reverse()
      : owners) {
      await forTarget(owner, async () => {
        const owned = { ...owner, peers: run.targets.filter(live) };
        for (const row of page.page) {
          if (!(await isOwned(ctx, table, row, owned))) continue;
          if (run.phase === "verify") {
            owner.state = "stopped";
            owner.reason = "writer_active";
            break;
          }
          const deletion: DeletionContext = {
            ctx,
            runId: run._id,
            target: owned,
            deleted,
          };
          await deleteDataRow(deletion, table, row);
          deleted = deletion.deleted;
        }
        const { peers, ...updated } = owned;
        // Verification stops must not be overwritten by the deletion context.
        if (run.phase !== "verify") Object.assign(owner, updated);
        else
          owner.rateLimitIdentifiersShared = updated.rateLimitIdentifiersShared;
      });
    }
    run.cursor = page.continueCursor;
    if (page.isDone) {
      run.cursor = null;
      if (scan) advanceTable(run);
      else if (entry.rule.kind === "parent") run.parentIndex++;
      else run.targetIndex++;
    }
    await schedule(ctx, run);
  },
});

export const stepAccountPurge = internalMutation({
  args: { runId: v.id("crystalAccountPurgeRuns"), generation: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const stored = await ctx.db.get(args.runId);
    if (
      !stored ||
      stored.status !== "running" ||
      stored.generation !== args.generation
    )
      return;
    try {
      await ctx.runMutation(api.executeAccountPurgeStep, args);
    } catch (error) {
      const run = (await loadRun(ctx, args.runId))!;
      // Some Convex adapters retain the serialized application-error payload.
      let data: any = error instanceof ConvexError ? error.data : null;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      const retryable = (target: TargetState) =>
        target.state === "pending" || live(target);
      const target =
        run.targets.find(
          (target) => retryable(target) && target.userId === data?.userId,
        ) ??
        run.targets.find(
          (target, index) => retryable(target) && index === run.targetIndex,
        ) ??
        run.targets.find(retryable);
      if (!target) throw error;
      target.lastError =
        typeof data?.code === "string" &&
        (errorCodes.has(data.code) || data.code === "unexpected_error")
          ? data.code
          : errorCode(error);
      target.consecutiveFailures = (target.consecutiveFailures ?? 0) + 1;
      if (target.consecutiveFailures >= 3) {
        target.state = "stopped";
        target.reason = target.lastError;
      }
      await schedule(ctx, run);
    }
  },
});

export const resumeAccountPurge = internalMutation({
  args: { runId: v.id("crystalAccountPurgeRuns") },
  handler: async (ctx, args) => {
    const run = await loadRun(ctx, args.runId, "none");
    if (!run) throw new Error("run_missing");
    if (run.status === "running") await schedule(ctx, run);
    return { runId: run._id, status: run.status };
  },
});

export const abandonAccountPurge = internalMutation({
  args: {
    runId: v.id("crystalAccountPurgeRuns"),
    confirm: v.literal("ABANDON"),
  },
  handler: async (ctx, args) => {
    const run = await loadRun(ctx, args.runId, "none");
    if (!run) throw new Error("run_missing");
    if (run.status !== "complete") {
      run.status = "abandoned";
      for (const target of run.targets) {
        if (target.state !== "done") {
          target.state = "stopped";
          target.reason = "abandoned";
        }
      }
      await schedule(ctx, run);
    }
    return { runId: run._id, status: run.status };
  },
});

export const verificationParentsPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalAccountPurgeTargets")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({
        cursor: args.cursor,
        numItems: PAGE_SIZE,
        maximumBytesRead: MAX_BYTES,
      });
    return {
      parents: page.page.map((row) => row.parents),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const verifyAccountsPurged = internalAction({
  args: { userIds: v.array(v.id("users")), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    if (
      !args.userIds.length ||
      args.userIds.length > 25 ||
      new Set(args.userIds).size !== args.userIds.length
    )
      throw new Error("invalid_targets");
    return readReport(ctx, "verify", args);
  },
});
