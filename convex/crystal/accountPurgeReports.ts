import { applyDependencyPage, type DependencyScan } from "./accountPurgeGuards";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  ACCOUNT_PURGE_TABLES,
  PURGE_TABLE_NAMES,
} from "./accountPurgeRegistry";
import {
  emptyParents,
  MAX_REPORT_BYTES,
  type Evidence,
  type Parents,
} from "./accountPurgeModel";

const api = (internal as any).crystal.accountPurge;
const MAX_QUERIES = 32;
const TIME_SLICE_MS = 5000;
type ReportTarget = DependencyScan & {
  userId: Id<"users">;
  parents: Parents;
  eligible?: boolean;
  evidence?: Evidence;
  claimedRateLimits?: string[];
  removedCredentials?: string[];
};
type FileCounts = {
  filesSkippedInvalidKey: number;
  filesAlreadyMissing: number;
  rateLimitIdentifiersShared: number;
};
type ReportState = {
  version: 3;
  dependencyStartedAt: number;
  request: string;
  phase: "dependencies" | "guards" | "parents" | "counts" | "done";
  targets: ReportTarget[];
  targetIndex: number;
  sourceIndex: number;
  tableIndex: number;
  groupIndex: number;
  parentIndex: number;
  cursor: string | null;
  eligibleIds: string[];
  counts: Record<string, Record<string, number>>;
  exempt: Record<string, Record<string, number>>;
  files: Record<string, FileCounts>;
  scanRowsRead: Record<string, number>;
};

function mergeParents(target: ReportTarget, incoming: Parents) {
  for (const key of ["sessions", "accounts", "memories"] as const) {
    target.parents[key] = [
      ...new Set([...target.parents[key], ...incoming[key]]),
    ];
  }
}

/** Read-only continuation. At most 32 queries / a five-second time slice per invocation. */
export async function readReport(
  ctx: ActionCtx,
  mode: "plan" | "verify",
  args: any,
) {
  const { cursor, ...requestArgs } = args;
  const request = JSON.stringify({ mode, ...requestArgs });
  const ids: Id<"users">[] =
    mode === "plan"
      ? args.targets.map((target: any) => target.userId)
      : args.userIds;
  const state: ReportState = cursor
    ? JSON.parse(cursor)
    : {
        version: 3,
        dependencyStartedAt: Date.now(),
        request,
        phase: mode === "plan" ? "dependencies" : "parents",
        targets: ids.map((userId) => ({ userId, parents: emptyParents() })),
        targetIndex: 0,
        sourceIndex: 0,
        tableIndex: 0,
        groupIndex: 0,
        parentIndex: 0,
        cursor: null,
        eligibleIds: ids,
        counts: {},
        exempt: {},
        files: {},
        scanRowsRead: {},
      };
  if (state.version !== 3 || state.request !== request)
    throw new Error("invalid_report_cursor");
  for (const id of ids) {
    state.counts[id] ??= {};
    state.exempt[id] ??= {};
    state.files[id] ??= {
      filesSkippedInvalidKey: 0,
      filesAlreadyMissing: 0,
      rateLimitIdentifiersShared: 0,
    };
  }
  const started = Date.now();
  let queries = 0;
  while (
    state.phase !== "done" &&
    queries < MAX_QUERIES &&
    Date.now() - started < TIME_SLICE_MS
  ) {
    if (state.phase === "dependencies") {
      const target = args.targets[state.targetIndex];
      if (!target) {
        state.phase = "guards";
        state.targetIndex = 0;
        continue;
      }
      const scan = state.targets[state.targetIndex];
      const page = await ctx.runQuery(api.dependencyPage, {
        target,
        targets: args.targets,
        sourceIndex: state.sourceIndex,
        cursor: state.cursor,
      });
      queries++;
      const next = applyDependencyPage(scan, page, state.sourceIndex);
      state.sourceIndex = next.sourceIndex;
      state.cursor = next.cursor;
      if (next.complete) state.targetIndex++;
      continue;
    }
    if (state.phase === "guards") {
      const target = args.targets[state.targetIndex];
      if (!target) {
        const eligibleIds = state.targets
          .filter((target) => target.eligible)
          .map((target) => target.userId);
        state.eligibleIds = eligibleIds;
        state.phase = "counts";
        continue;
      }
      if (state.targets[state.targetIndex].eligible !== undefined) {
        state.targetIndex++;
        continue;
      }
      const results = await ctx.runQuery(api.inspectPlanComponent, {
        ...requestArgs,
        target,
        dependencyStartedAt: state.dependencyStartedAt,
        scans: Object.fromEntries(
          state.targets.map(
            ({
              userId,
              dependencyPeers,
              dependencyRefusal,
              dependenciesComplete,
            }) => [
              userId,
              { dependencyPeers, dependencyRefusal, dependenciesComplete },
            ],
          ),
        ),
        // Only earlier successful components are live; inspection adds each member's self.
        rateLimitPeers: args.targets.filter(
          (_peer: any, index: number) => state.targets[index].eligible,
        ),
        removedCredentials: state.targets.flatMap(
          (target) => target.removedCredentials ?? [],
        ),
      });
      queries++;
      for (const result of results)
        Object.assign(state.targets[ids.indexOf(result.userId)], result);
      state.targetIndex++;
      continue;
    }
    if (state.phase === "parents") {
      const target = state.targets[state.targetIndex];
      if (!target) {
        state.phase = "counts";
        continue;
      }
      let page: any;
      if (state.sourceIndex === 0) {
        page = await ctx.runQuery(api.verificationParentsPage, {
          userId: target.userId,
          cursor: state.cursor,
        });
        for (const parents of page.parents) mergeParents(target, parents);
      } else {
        const [table, key] = [
          ["authSessions", "sessions"],
          ["authAccounts", "accounts"],
          ["crystalMemories", "memories"],
        ][state.sourceIndex - 1];
        page = await ctx.runQuery(api.guardPage, {
          target: { userId: target.userId, emailSha256: "0".repeat(64) },
          table,
          cursor: state.cursor,
        });
        const parents = emptyParents();
        parents[key as keyof Parents] = page.rows.map((row: any) => row._id);
        mergeParents(target, parents);
      }
      queries++;
      state.cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) {
        state.sourceIndex++;
        if (state.sourceIndex === 4) {
          state.targetIndex++;
          state.sourceIndex = 0;
        }
      }
      continue;
    }
    const table = PURGE_TABLE_NAMES[state.tableIndex];
    if (!table) {
      state.phase = "done";
      continue;
    }
    const entry = ACCOUNT_PURGE_TABLES[table];
    const views = state.targets
      .filter(
        (target) =>
          table !== "authRateLimits" || mode === "verify" || target.eligible,
      )
      .map(({ userId, parents }) => ({
        userId,
        parents,
      }));
    const groups =
      entry.access.kind === "scan" ? [views] : views.map((target) => [target]);
    // Null-owner associations use the undefined partition of the user-led index,
    // not a full graph scan, and are counted once for the whole batch.
    if (table === "crystalAssociations") groups.push(views);
    const group = groups[state.groupIndex];
    if (!group) {
      state.tableIndex++;
      state.groupIndex = 0;
      state.parentIndex = 0;
      state.cursor = null;
      continue;
    }
    const nullOwners =
      table === "crystalAssociations" && state.groupIndex === views.length;
    const page: any = await ctx.runQuery(api.countPage, {
      table,
      targets: group,
      peers: views.filter(
        (target) =>
          mode === "verify" || state.eligibleIds.includes(target.userId),
      ),
      parentIndex: state.parentIndex,
      cursor: state.cursor,
      nullOwners,
      ...(mode === "plan" && table === "authRateLimits"
        ? {
            claimedRateLimits: Object.fromEntries(
              state.targets.flatMap((target) =>
                (target.claimedRateLimits ?? []).map((id) => [
                  id,
                  target.userId,
                ]),
              ),
            ),
          }
        : {}),
    });
    queries++;
    const output = entry.rule.kind === "exempt" ? state.exempt : state.counts;
    for (const target of group) {
      const id = target.userId;
      output[id][table] = (output[id][table] ?? 0) + (page.counts[id] ?? 0);
      state.files[id].filesSkippedInvalidKey +=
        page.files[id]?.filesSkippedInvalidKey ?? 0;
      state.files[id].filesAlreadyMissing +=
        page.files[id]?.filesAlreadyMissing ?? 0;
      state.files[id].rateLimitIdentifiersShared +=
        page.files[id]?.rateLimitIdentifiersShared ?? 0;
    }
    if (entry.access.kind === "scan" || nullOwners)
      state.scanRowsRead[table] =
        (state.scanRowsRead[table] ?? 0) + page.rowsRead;
    state.cursor = page.isDone ? null : page.continueCursor;
    if (page.isDone) {
      state.parentIndex++;
      if (state.parentIndex >= page.parentCount) {
        state.groupIndex++;
        state.parentIndex = 0;
      }
    }
  }
  const done = state.phase === "done";
  const nextCursor = done ? null : JSON.stringify(state);
  if (nextCursor && nextCursor.length > MAX_REPORT_BYTES)
    throw new Error("report_state_budget");
  const continuation = {
    done,
    cursor: nextCursor,
    scanRowsRead: state.scanRowsRead,
  };
  if (mode === "verify")
    return {
      ...continuation,
      covered: state.counts,
      exempt: state.exempt,
      rateLimitIdentifiersShared: Object.fromEntries(
        ids.map((id) => [id, state.files[id].rateLimitIdentifiersShared]),
      ),
    };
  return {
    ...continuation,
    targets: state.targets.map(({ userId, eligible, evidence }) => ({
      userId,
      eligible: eligible ?? false,
      ...(evidence ? { evidence } : {}),
      counts: eligible ? state.counts[userId] : {},
      exempt: state.exempt[userId],
      ...state.files[userId],
    })),
  };
}
