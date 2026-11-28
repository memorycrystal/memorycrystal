import type { QueryCtx } from "../_generated/server";
import { AUTH_TABLES } from "./accountPurgeRegistry";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { sha256Hex } from "./crypto";
import {
  isOwned,
  userIdentifierHashes,
  withoutIds,
} from "./accountPurgeOwnership";
import {
  assertKeysSafeToDeleteWithRotations,
  RotationIntegrityRefusal,
} from "./apiKeyRotationIntegrity";
import {
  emptyParents,
  MAX_DELETIONS,
  MAX_PARENTS,
  type Evidence,
  type Options,
  type Parents,
  type Target,
} from "./accountPurgeModel";

export type GuardRow = Record<string, any>;
const guardSources = [
  ["users", "by_id", "_id"],
  ["crystalApiKeys", "by_user", "userId"],
  ["crystalApiKeyRotations", "by_user_label", "userId"],
  ["crystalDashboardTotals", "by_user", "userId"],
  ["crystalSessions", "by_user", "userId"],
  ["authSessions", "userId", "userId"],
  ["authAccounts", "userIdAndProvider", "userId"],
  ["crystalMemories", "by_user_created", "userId"],
  ["crystalUserProfiles", "by_user", "userId"],
  ["tenants", "by_userId", "userId"],
  ["crystalAssets", "by_user", "userId"],
] as const;
export const GUARD_SOURCES = guardSources.filter(
  ([table]) => table in schema.tables,
) as ReadonlyArray<readonly [TableNames, string, string]>;
export const AUTH_CHILDREN = [
  ["authVerifiers", "by_purge_session", "sessionId", "sessions"],
  ["authVerificationCodes", "accountId", "accountId", "accounts"],
  ["authRateLimits", "identifier", "identifier", "accounts"],
] as const;
export type GuardSnapshot = Record<string, GuardRow[]>;

/** The shared rotation checker may collect; bound its adapter, never truncate. */
export function boundedIntegrityContext(ctx: Pick<QueryCtx, "db">) {
  return {
    db: {
      get: (id: any) => ctx.db.get(id),
      query: (table: any) => ({
        withIndex: (index: string, range: any) => ({
          collect: async () => {
            const rows = await (ctx.db.query(table) as any)
              .withIndex(index, range)
              .take(MAX_DELETIONS + 1);
            if (rows.length > MAX_DELETIONS) throw new Error("claim_budget");
            return rows;
          },
        }),
      }),
    },
  };
}

/** Only ids, booleans, enum decisions and numeric evidence leave guard queries. */
export async function projectGuardRow(
  ctx: QueryCtx,
  table: string,
  row: any,
): Promise<GuardRow> {
  const result: GuardRow = { _id: row._id, _creationTime: row._creationTime };
  for (const field of [
    "lastUsedAt",
    "lastCaptureCreatedAt",
    "lastActiveAt",
    "createdAt",
    "lastAccessedAt",
    "timestamp",
  ])
    if (typeof row[field] === "number") result[field] = row[field];
  if (table === "users")
    result.emailSha256 =
      typeof row.email === "string"
        ? await sha256Hex(row.email.trim().toLowerCase())
        : "";
  if (table === "crystalUserProfiles") {
    result.protectedRole =
      row.roles?.some((r: string) => r === "admin" || r === "manager") ?? false;
    result.subscriptionStatus = row.subscriptionStatus;
    result.polar = Boolean(row.polarSubscriptionId || row.polarCustomerId);
  }
  if (table === "crystalAssets")
    result.external = (row.storageProvider ?? "convex") !== "convex";
  if (table === "crystalApiKeys" || table === "crystalApiKeyRotations") {
    try {
      const keys = await ctx.db
        .query("crystalApiKeys")
        .withIndex("by_user", (q) => q.eq("userId", row.userId))
        .take(MAX_DELETIONS + 1);
      const rotations = await ctx.db
        .query("crystalApiKeyRotations")
        .withIndex("by_user_label", (q) => q.eq("userId", row.userId))
        .take(MAX_DELETIONS + 1);
      if (keys.length + rotations.length > MAX_DELETIONS)
        throw new Error("claim_budget");
      await assertKeysSafeToDeleteWithRotations(boundedIntegrityContext(ctx), {
        ownerUserId: row.userId,
        keys,
        ownedRotations: rotations,
      });
      result.integrity = true;
    } catch (error) {
      if (error instanceof Error && error.message === "claim_budget") {
        result.claimBudget = true;
      } else {
        if (!(error instanceof RotationIntegrityRefusal)) throw error;
        result.integrity = false;
      }
    }
  }
  return result;
}

export function decideGuards(
  target: Target,
  options: Options,
  snapshot: GuardSnapshot,
  dependent: boolean,
  now: number,
) {
  const evidence: Evidence = {
    checkedAt: now,
    cutoff: now - (options.inactiveDays ?? 30) * 86_400_000,
    signals: {},
    refusals: [],
    overrides: [],
  };
  const refuse = (reason: string) => {
    if (!evidence.refusals.includes(reason)) evidence.refusals.push(reason);
  };
  const force = options.force?.includes(target.userId) ?? false;
  const parents = emptyParents();
  for (const [table, key] of [
    ["authSessions", "sessions"],
    ["authAccounts", "accounts"],
    ["crystalMemories", "memories"],
  ] as const)
    parents[key] = (snapshot[table] ?? []).map((r) => r._id);
  const user = snapshot.users?.[0];
  if (!user || user.emailSha256 !== target.emailSha256) refuse("G1_identity");
  const signals = [
    ["accountAge", "users", "_creationTime"],
    ["apiKey", "crystalApiKeys", "lastUsedAt"],
    ["capture", "crystalDashboardTotals", "lastCaptureCreatedAt"],
    ["session", "crystalSessions", "lastActiveAt"],
    ["authSession", "authSessions", "_creationTime"],
    ["authRefresh", "authRefreshTokens", "_creationTime"],
    ["message", "crystalMessages", "timestamp"],
    ["memoryCreated", "crystalMemories", "createdAt"],
    ["memoryAccessed", "memoryAccessMax", "lastAccessedAt"],
  ];
  for (const [signal, table, field] of signals) {
    const times = (snapshot[table] ?? [])
      .map((row) => row[field])
      .filter((x) => typeof x === "number");
    if (!times.length) continue;
    const latest = Math.max(...times);
    evidence.signals[signal] = latest;
    if (latest >= evidence.cutoff) {
      if (force) evidence.overrides.push(`G2_${signal}`);
      else refuse(`G2_${signal}`);
    }
  }
  for (const profile of snapshot.crystalUserProfiles ?? []) {
    if (profile.protectedRole) refuse("G3_role");
    if (profile.polar) {
      if (
        options.polarCancelled?.includes(target.userId) &&
        ["cancelled", "inactive"].includes(profile.subscriptionStatus)
      )
        evidence.overrides.push("G3_polar_cancelled");
      else refuse("G3_polar");
    }
    if (
      ["active", "trialing", "unlimited"].includes(profile.subscriptionStatus)
    ) {
      // Trialing and administrative roles are never forceable. Polar always wins.
      if (
        force &&
        !profile.polar &&
        ["active", "unlimited"].includes(profile.subscriptionStatus)
      )
        evidence.overrides.push("G3_standing");
      else refuse("G3_standing");
    }
  }
  if ((snapshot.tenants ?? []).length) refuse("G4_tenant");
  if ((snapshot.crystalAssets ?? []).some((a) => a.external))
    refuse("G5_external_file");
  if (
    [
      ...(snapshot.crystalApiKeys ?? []),
      ...(snapshot.crystalApiKeyRotations ?? []),
    ].some((r) => r.integrity === false)
  )
    refuse("G6_rotation");
  if (dependent) refuse("G7_dependent");
  const credentialCount = [
    "authSessions",
    "authAccounts",
    "crystalApiKeys",
    "crystalApiKeyRotations",
    ...AUTH_CHILDREN.map((x) => x[0]),
  ].reduce((n, t) => n + (snapshot[t]?.length ?? 0), 0);
  if (
    Object.values(snapshot).some((rows) =>
      rows.some((row) => row.claimBudget),
    ) ||
    credentialCount > MAX_DELETIONS ||
    Object.values(snapshot).some((rows) => rows.length > MAX_PARENTS)
  )
    refuse("claim_budget");
  evidence.overrides = [...new Set(evidence.overrides)];
  return { evidence, parents, eligible: evidence.refusals.length === 0 };
}

/** Live dependency decision; foreign sources are resolved from documents, never mirrored owner strings. */
export async function dependencyOwners(
  ctx: QueryCtx,
  table: string,
  row: any,
  targetIds: string[] = [],
): Promise<string[]> {
  if (
    table === "crystalKbCopyMemoryMaps" ||
    table === "crystalKbCopyNodeMaps"
  ) {
    const sourceTable =
      table === "crystalKbCopyMemoryMaps" ? "crystalMemories" : "crystalNodes";
    const id = ctx.db.normalizeId(
      sourceTable,
      table === "crystalKbCopyMemoryMaps"
        ? row.sourceMemoryId
        : row.sourceNodeId,
    );
    const source = id ? await ctx.db.get(id) : null;
    return source &&
      source.userId !== row.targetUserId &&
      !targetIds.includes(row.targetUserId)
      ? [source.userId]
      : [];
  }
  if (table === "crystalAssociations") {
    const a = await ctx.db.get(row.fromMemoryId as Id<"crystalMemories">);
    const b = await ctx.db.get(row.toMemoryId as Id<"crystalMemories">);
    const owners = [
      ...new Set(
        [a?.userId, b?.userId].filter((id): id is string => Boolean(id)),
      ),
    ];
    if (row.userId != null)
      return owners.filter((owner) => owner !== row.userId);
    if (
      a?.userId &&
      b?.userId &&
      (a.userId === b.userId ||
        owners.every((owner) => targetIds.includes(owner)))
    )
      return [];
    return owners;
  }
  return [];
}

export async function inspectClaim(
  ctx: QueryCtx,
  target: Target,
  {
    options,
    peers = options.targets,
    dependencyPeers = [target],
    removedCredentials = new Set<string>(),
    dependencyStartedAt = 0,
  }: {
    options: Options;
    peers?: Target[];
    dependencyPeers?: Target[];
    removedCredentials?: ReadonlySet<string>;
    dependencyStartedAt?: number;
  },
) {
  const snapshot: GuardSnapshot = {};
  for (const [table, index, field] of GUARD_SOURCES) {
    let query = (ctx.db.query(table) as any).withIndex(index, (q: any) =>
      q.eq(field, target.userId),
    );
    if (table === "authAccounts") query = withoutIds(query, removedCredentials);
    const rows = await query.take(MAX_PARENTS + 1);
    snapshot[table] = [];
    // Rotation integrity is a graph-wide decision; do not repeat it per key.
    let integrity: { integrity?: boolean; claimBudget?: boolean } | undefined;
    for (const row of rows) {
      if (
        (table === "crystalApiKeys" || table === "crystalApiKeyRotations") &&
        integrity !== undefined
      )
        snapshot[table].push({
          _id: row._id,
          _creationTime: row._creationTime,
          ...(row.lastUsedAt === undefined
            ? {}
            : { lastUsedAt: row.lastUsedAt }),
          ...integrity,
        });
      else {
        const projected = await projectGuardRow(ctx, table, row);
        snapshot[table].push(projected);
        integrity = {
          ...(projected.integrity === undefined
            ? {}
            : { integrity: projected.integrity }),
          ...(projected.claimBudget ? { claimBudget: true } : {}),
        };
      }
    }
  }
  const parents: Parents = {
    sessions: snapshot.authSessions.map((x) => x._id),
    accounts: snapshot.authAccounts.map((x) => x._id),
    memories: snapshot.crystalMemories.map((x) => x._id),
  };
  const user = await ctx.db.get(target.userId);
  const identifierHashes = await userIdentifierHashes(user);
  for (const [table, index, field, key] of AUTH_CHILDREN) {
    snapshot[table] = [];
    if (table === "authRateLimits") {
      // Bound the identifier scan without refusing for unrelated/shared rows.
      // Later paged passes handle its remainder; account-ID revocation is complete.
      const candidates = new Map(
        (
          await withoutIds(ctx.db.query(table), removedCredentials).take(
            MAX_PARENTS,
          )
        ).map((row) => [row._id, row]),
      );
      for (const accountId of parents.accounts) {
        const rows = await withoutIds(
          ctx.db
            .query(table)
            .withIndex("identifier", (q) => q.eq("identifier", accountId)),
          removedCredentials,
        ).take(MAX_DELETIONS + 1);
        for (const row of rows) candidates.set(row._id, row);
      }
      for (const row of candidates.values()) {
        if (
          await isOwned(
            ctx,
            table,
            row,
            {
              userId: target.userId,
              parents,
              identifierHashes,
              peers: peers.map((peer) => ({
                userId: peer.userId,
                parents: emptyParents(),
              })),
            },
            removedCredentials,
          )
        )
          snapshot[table].push({
            _id: row._id,
            _creationTime: row._creationTime,
          });
        if (snapshot[table].length > MAX_DELETIONS) break;
      }
      continue;
    }
    for (const id of parents[key]) {
      const rows = await (ctx.db.query(table) as any)
        .withIndex(index, (q: any) => q.eq(field, id))
        .take(MAX_DELETIONS + 1);
      snapshot[table].push(
        ...rows.map((r: any) => ({
          _id: r._id,
          _creationTime: r._creationTime,
        })),
      );
      if (snapshot[table].length > MAX_DELETIONS) break;
    }
  }
  // Activity stays live at claim time; old tokens are not atomic credentials.
  snapshot.authRefreshTokens = [];
  for (const sessionId of parents.sessions) {
    const newest = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) =>
        q.eq("sessionId", sessionId as Id<"authSessions">),
      )
      .order("desc")
      .first();
    if (newest)
      snapshot.authRefreshTokens.push({
        _id: newest._id,
        _creationTime: newest._creationTime,
      });
  }
  snapshot.crystalMessages = await ctx.db
    .query("crystalMessages")
    .withIndex("by_user_time", (q) => q.eq("userId", target.userId))
    .order("desc")
    .take(1);
  snapshot.memoryAccessMax = [];
  for (const archived of [false, true]) {
    const row = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_archived_last_accessed", (q) =>
        q.eq("userId", target.userId).eq("archived", archived),
      )
      .order("desc")
      .first();
    if (row)
      snapshot.memoryAccessMax.push({ lastAccessedAt: row.lastAccessedAt });
  }
  const delta = await dependencyDelta(
    ctx,
    target,
    dependencyPeers,
    dependencyStartedAt,
  );
  let dependent = delta === "G7_dependent";
  if (delta === "claim_budget")
    snapshot.dependencyBudget = [{ claimBudget: true }];
  for (const [table, index, field, source] of [
    ["crystalAssociations", "by_purge_from", "fromMemoryId", "crystalMemories"],
    ["crystalAssociations", "by_purge_to", "toMemoryId", "crystalMemories"],
  ]) {
    for (const parent of snapshot[source]) {
      const rows = await (ctx.db.query(table as any) as any)
        .withIndex(index, (q: any) => q.eq(field, parent._id))
        .take(MAX_PARENTS + 1);
      if (rows.length > MAX_PARENTS) dependent = true;
      for (const row of rows)
        if (
          (
            await dependencyOwners(
              ctx,
              table,
              row,
              dependencyPeers.map((t) => t.userId),
            )
          ).includes(target.userId)
        )
          dependent = true;
    }
  }
  return {
    ...decideGuards(target, options, snapshot, dependent, Date.now()),
    snapshot,
    identifierHashes,
  };
}

export type DependencyScan = {
  dependencyPeers?: string[];
  dependencyRefusal?: string;
  dependenciesComplete?: boolean;
};
const COPY_SOURCES = [
  [
    "crystalMemories",
    "by_purge_user",
    "crystalKbCopyMemoryMaps",
    "sourceMemoryId",
  ],
  ["crystalNodes", "by_purge_user", "crystalKbCopyNodeMaps", "sourceNodeId"],
] as const;
// Both candidate fan-out and new-source fan-out fail closed at the cap.
export const DEPENDENCY_CAP = 200;
const DEPENDENCY_PAGE = 32;
const DEPENDENCY_CLOCK_SKEW_MARGIN_MS = 60_000;
export const samePeers = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

async function checkCopyCandidates(
  ctx: QueryCtx,
  sourceIndex: number,
  sources: { _id: string }[],
  target: Target,
  peers: Target[],
): Promise<string | undefined> {
  const [, , table, field] = COPY_SOURCES[sourceIndex];
  let remaining = DEPENDENCY_CAP;
  for (const source of sources) {
    const rows = await (ctx.db.query(table) as any)
      .withIndex("by_purge_source", (q: any) => q.eq(field, source._id))
      .take(remaining);
    if (rows.length >= remaining) return "claim_budget";
    remaining -= rows.length;
    for (const row of rows)
      if (
        (
          await dependencyOwners(
            ctx,
            table,
            row,
            peers.map((t) => t.userId),
          )
        ).includes(target.userId)
      )
        return "G7_dependent";
  }
}

/** One owner-index page, before any credential or customer-data write. */
export async function scanDependencies(
  ctx: QueryCtx,
  target: Target,
  targets: Target[],
  sourceIndex: number,
  cursor: string | null,
) {
  const component = (await claimComponents(ctx, targets)).find((group) =>
    group.targets.some((peer) => peer.userId === target.userId),
  )!;
  const [table, index] = COPY_SOURCES[sourceIndex];
  const page = await (ctx.db.query(table) as any)
    .withIndex(index, (q: any) => q.eq("userId", target.userId))
    .paginate({
      cursor,
      numItems: DEPENDENCY_PAGE,
      maximumBytesRead: 1024 * 1024,
    });
  return {
    dependencyPeers: component.targets.map((peer) => peer.userId),
    dependencyRefusal: component.overBudget
      ? "claim_budget"
      : await checkCopyCandidates(
          ctx,
          sourceIndex,
          page.page,
          target,
          component.targets,
        ),
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

/** Apply the same peer/refusal and cursor transitions in plans and runs. */
export function applyDependencyPage(
  scan: DependencyScan,
  page: Awaited<ReturnType<typeof scanDependencies>>,
  sourceIndex: number,
) {
  if (
    scan.dependencyPeers &&
    !samePeers(scan.dependencyPeers, page.dependencyPeers)
  )
    scan.dependencyRefusal = "G7_dependent";
  scan.dependencyPeers = page.dependencyPeers;
  scan.dependencyRefusal ??= page.dependencyRefusal;
  const nextSourceIndex = sourceIndex + (page.isDone ? 1 : 0);
  const complete = Boolean(
    scan.dependencyRefusal || nextSourceIndex === COPY_SOURCES.length,
  );
  if (complete) scan.dependenciesComplete = true;
  return {
    complete,
    sourceIndex: complete ? 0 : nextSourceIndex,
    cursor: complete || page.isDone ? null : page.continueCursor,
  };
}

/** Atomic delta: new maps AND new owned sources, never mirrored source ownership. */
async function dependencyDelta(
  ctx: QueryCtx,
  target: Target,
  peers: Target[],
  startedAt: number,
): Promise<string | undefined> {
  const since = startedAt - DEPENDENCY_CLOCK_SKEW_MARGIN_MS;
  for (const [
    sourceIndex,
    [source, ownerIndex, table],
  ] of COPY_SOURCES.entries()) {
    const maps = await ctx.db
      .query(table)
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .take(DEPENDENCY_CAP);
    if (maps.length >= DEPENDENCY_CAP) return "claim_budget";
    for (const row of maps)
      if (
        (
          await dependencyOwners(
            ctx,
            table,
            row,
            peers.map((t) => t.userId),
          )
        ).includes(target.userId)
      )
        return "G7_dependent";
    const sources = await (ctx.db.query(source) as any)
      .withIndex(ownerIndex, (q: any) =>
        q.eq("userId", target.userId).gte("_creationTime", since),
      )
      .take(DEPENDENCY_CAP);
    if (sources.length >= DEPENDENCY_CAP) return "claim_budget";
    const refusal = await checkCopyCandidates(
      ctx,
      sourceIndex,
      sources,
      target,
      peers,
    );
    if (refusal) return refusal;
  }
}

/** Discover undirected null-owner links with the same bounded parent/index reads as G7. */
export async function claimComponents(ctx: QueryCtx, targets: Target[]) {
  const groups = targets.map((target) => [target]);
  const overBudget = new Set<string>();
  for (const target of targets) {
    const memories = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) => q.eq("userId", target.userId))
      .take(MAX_PARENTS + 1);
    if (memories.length > MAX_PARENTS) overBudget.add(target.userId);
    for (const memory of memories) {
      for (const [index, field] of [
        ["by_purge_from", "fromMemoryId"],
        ["by_purge_to", "toMemoryId"],
      ] as const) {
        const rows = await ctx.db
          .query("crystalAssociations")
          .withIndex(index, (q) => q.eq(field, memory._id))
          .take(MAX_PARENTS + 1);
        if (rows.length > MAX_PARENTS) overBudget.add(target.userId);
        for (const row of rows) {
          if (row.userId != null) continue;
          const other = await ctx.db.get(
            field === "fromMemoryId" ? row.toMemoryId : row.fromMemoryId,
          );
          const left = groups.find((group) => group.includes(target))!;
          const right = groups.find((group) =>
            group.some((peer) => peer.userId === other?.userId),
          );
          if (right && left !== right) {
            left.push(...right);
            groups.splice(groups.indexOf(right), 1);
          }
        }
      }
    }
  }
  // Component order follows the first requested target, not edge traversal order.
  return groups
    .map((group) => ({
      targets: targets.filter((target) => group.includes(target)),
      overBudget: group.some((target) => overBudget.has(target.userId)),
    }))
    .sort(
      (a, b) => targets.indexOf(a.targets[0]) - targets.indexOf(b.targets[0]),
    );
}

/** Read-only claim simulation: earlier successful claims have removed these credentials. */
export async function inspectComponent(
  ctx: QueryCtx,
  component: Awaited<ReturnType<typeof claimComponents>>[number],
  {
    options,
    earlierPeers,
    removedCredentials = [],
    dependencyStartedAt = 0,
    scans,
  }: {
    options: Options;
    earlierPeers: Target[];
    removedCredentials?: string[];
    dependencyStartedAt?: number;
    scans?: Record<string, DependencyScan>;
  },
) {
  const checks = [];
  const peers = [...earlierPeers];
  const removed = new Set(removedCredentials);
  const credentialIds = new Set<string>();
  // Stable member order makes budgets and shared-identifier attribution independent
  // of the order in which the operator listed members of a component.
  const members = [...component.targets].sort((a, b) =>
    a.userId.localeCompare(b.userId),
  );
  for (const target of members) {
    const check = await inspectClaim(ctx, target, {
      options,
      peers: [...peers, target],
      dependencyPeers: component.targets,
      removedCredentials: removed,
      dependencyStartedAt,
    });
    if (scans) {
      const scan = scans[target.userId];
      const reason = !scan?.dependenciesComplete
        ? "claim_budget"
        : (scan.dependencyRefusal ??
          (samePeers(
            scan.dependencyPeers ?? [],
            component.targets.map((t) => t.userId),
          )
            ? undefined
            : "G7_dependent"));
      if (reason && !check.evidence.refusals.includes(reason))
        check.evidence.refusals.push(reason);
      check.eligible = check.evidence.refusals.length === 0;
    }
    checks.push({ ...check, userId: target.userId });
    for (const table of AUTH_TABLES)
      for (const row of check.snapshot[table] ?? []) credentialIds.add(row._id);
    if (check.eligible) {
      peers.push(target);
      for (const table of ["authAccounts", "authRateLimits"])
        for (const row of check.snapshot[table] ?? []) removed.add(row._id);
    }
  }
  const budget = component.overBudget || credentialIds.size > MAX_DELETIONS;
  const refused = budget || checks.some((check) => !check.eligible);
  for (const check of checks) {
    if (budget && !check.evidence.refusals.includes("claim_budget"))
      check.evidence.refusals.unshift("claim_budget");
    if (refused && !check.evidence.refusals.length)
      check.evidence.refusals.push("G7_dependent");
    check.eligible = !refused;
  }
  return checks;
}
