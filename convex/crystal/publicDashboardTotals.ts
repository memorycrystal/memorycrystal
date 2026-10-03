// Public mirror subset: shared user-scoped aggregate helpers only.
// Pre-merge audit: run this to confirm no new strength-write sites were added
// grep -rn 'patch.*strength\|strength: ' convex/crystal/ | grep -v test | grep -v __tests__ | grep db.patch
// Expected: exactly 6 results (5 endpoint mutations + 1 salience).

export const memoryStoreValues = ["sensory", "episodic", "semantic", "procedural", "prospective"] as const;
export type MemoryStore = (typeof memoryStoreValues)[number];

export type DashboardTotalsByStore = {
  sensory: number;
  episodic: number;
  semantic: number;
  procedural: number;
  prospective: number;
};

export type DashboardTotalsSnapshot = {
  _id?: string;
  userId: string;
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  totalMessages: number;
  totalStrength: number;
  activeRecallCount: number;
  activeRecalledMemories: number;
  // ILL-179 — subset of activeMemories that carries a knowledgeBaseId.
  knowledgeBaseMemories: number;
  activeMemoriesByStore: DashboardTotalsByStore;
  activeStoreCount: number;
  lastCaptureMemoryId?: string;
  lastCaptureStore?: MemoryStore;
  lastCaptureTitle?: string;
  lastCaptureCreatedAt?: number;
  updatedAt: number;
};

export type DashboardTotalsDelta = {
  totalMemoriesDelta?: number;
  activeMemoriesDelta?: number;
  archivedMemoriesDelta?: number;
  totalMessagesDelta?: number;
  totalStrengthDelta?: number;
  activeRecallCountDelta?: number;
  activeRecalledMemoriesDelta?: number;
  // ILL-179 — moves in lockstep with activeMemoriesDelta, but only for rows that
  // carry a knowledgeBaseId. Never set it independently of activeMemoriesDelta.
  knowledgeBaseMemoriesDelta?: number;
  activeMemoriesByStoreDelta?: Partial<Record<MemoryStore, number>>;
  lastCaptureMemoryId?: string;
  lastCaptureStore?: MemoryStore;
  lastCaptureTitle?: string;
  lastCaptureCreatedAt?: number;
};

type NormalizeStorePayloadOptions = {
  omitRecallAggregate?: boolean;
};

const ZERO_COUNTS: DashboardTotalsByStore = {
  sensory: 0,
  episodic: 0,
  semantic: 0,
  procedural: 0,
  prospective: 0,
};


function clampCount(value: unknown): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isFinite(numericValue)) return 0;
  return Math.max(0, Math.floor(numericValue));
}

// M7 — totalStrength accumulates floating-point strength sums; do NOT floor
// like clampCount, but do clamp to >=0 to avoid negative drift on miscount.
function clampStrengthSum(value: unknown): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numericValue)) return 0;
  return Math.max(0, numericValue);
}

function normalizeStore(store: string): MemoryStore | undefined {
  if (memoryStoreValues.includes(store as MemoryStore)) {
    return store as MemoryStore;
  }
  return undefined;
}

function normalizeByStore(value: unknown): DashboardTotalsByStore {
  const input = (value ?? {}) as Partial<Record<string, number>>;
  return {
    sensory: clampCount(input.sensory ?? 0),
    episodic: clampCount(input.episodic ?? 0),
    semantic: clampCount(input.semantic ?? 0),
    procedural: clampCount(input.procedural ?? 0),
    prospective: clampCount(input.prospective ?? 0),
  };
}

function normalizeTotals(value: any): DashboardTotalsSnapshot {
  const activeMemoriesByStore = normalizeByStore(value?.activeMemoriesByStore);
  const activeStoreCount = Number(
    Object.values(activeMemoriesByStore).filter((count) => count > 0).length
  );

  const totalMemories = clampCount(value?.totalMemories);
  const activeMemories = clampCount(value?.activeMemories);
  const archivedMemories = clampCount(value?.archivedMemories);
  const totalMessages = clampCount(value?.totalMessages);
  const totalStrength = clampStrengthSum(value?.totalStrength);
  const activeRecallCount = clampCount(value?.activeRecallCount);
  const activeRecalledMemories = clampCount(value?.activeRecalledMemories);
  // ILL-179 — absent on rows written before the field existed; those read as 0,
  // which makes every active memory look non-KB until the backfill runs.
  const knowledgeBaseMemories = clampCount(value?.knowledgeBaseMemories);

  return {
    _id: value?._id,
    userId: value?.userId ?? "",
    totalMemories,
    activeMemories,
    archivedMemories,
    totalMessages,
    totalStrength,
    activeRecallCount,
    activeRecalledMemories,
    knowledgeBaseMemories,
    activeMemoriesByStore,
    activeStoreCount,
    lastCaptureMemoryId: value?.lastCaptureMemoryId,
    lastCaptureStore: normalizeStore(value?.lastCaptureStore) ?? undefined,
    lastCaptureTitle: value?.lastCaptureTitle,
    lastCaptureCreatedAt: value?.lastCaptureCreatedAt,
    updatedAt: clampCount(value?.updatedAt),
  };
}

function hasStoredRecallAggregate(value: any): boolean {
  return typeof value?.activeRecallCount === "number" && typeof value?.activeRecalledMemories === "number";
}


function newEmptyTotals(userId: string): DashboardTotalsSnapshot {
  return {
    userId,
    totalMemories: 0,
    activeMemories: 0,
    archivedMemories: 0,
    totalMessages: 0,
    totalStrength: 0,
    activeRecallCount: 0,
    activeRecalledMemories: 0,
    knowledgeBaseMemories: 0,
    activeMemoriesByStore: { ...ZERO_COUNTS },
    activeStoreCount: 0,
    updatedAt: Date.now(),
  };
}

function applyDelta(current: DashboardTotalsSnapshot, delta: DashboardTotalsDelta): DashboardTotalsSnapshot {
  const next: DashboardTotalsSnapshot = {
    ...current,
    totalMemories: clampCount(current.totalMemories + (delta.totalMemoriesDelta ?? 0)),
    activeMemories: clampCount(current.activeMemories + (delta.activeMemoriesDelta ?? 0)),
    archivedMemories: clampCount(current.archivedMemories + (delta.archivedMemoriesDelta ?? 0)),
    totalMessages: clampCount(current.totalMessages + (delta.totalMessagesDelta ?? 0)),
    totalStrength: clampStrengthSum(
      (current.totalStrength ?? 0) + (delta.totalStrengthDelta ?? 0),
    ),
    activeRecallCount: clampCount(current.activeRecallCount + (delta.activeRecallCountDelta ?? 0)),
    activeRecalledMemories: clampCount(current.activeRecalledMemories + (delta.activeRecalledMemoriesDelta ?? 0)),
    // ILL-179 — clamped like every other counter: drift can never drive the KB
    // count negative, which would make non-KB active memories read too high.
    knowledgeBaseMemories: clampCount(
      (current.knowledgeBaseMemories ?? 0) + (delta.knowledgeBaseMemoriesDelta ?? 0),
    ),
    activeMemoriesByStore: { ...current.activeMemoriesByStore },
    updatedAt: Date.now(),
  };

  const byStoreDelta = delta.activeMemoriesByStoreDelta ?? {};
  for (const store of memoryStoreValues) {
    const existing = current.activeMemoriesByStore[store];
    const adjustment = byStoreDelta[store] ?? 0;
    next.activeMemoriesByStore[store] = clampCount(existing + adjustment);
  }

  if (delta.lastCaptureCreatedAt !== undefined) {
    const previousCreatedAt = current.lastCaptureCreatedAt ?? Number.NEGATIVE_INFINITY;
    if (delta.lastCaptureCreatedAt >= previousCreatedAt) {
      next.lastCaptureCreatedAt = delta.lastCaptureCreatedAt;
      next.lastCaptureStore = delta.lastCaptureStore;
      next.lastCaptureTitle = delta.lastCaptureTitle;
      next.lastCaptureMemoryId = delta.lastCaptureMemoryId;
    }
  }

  next.activeStoreCount = Object.values(next.activeMemoriesByStore).filter((count) => count > 0).length;

  return next;
}

function normalizeStorePayload(
  payload: DashboardTotalsSnapshot,
  options: NormalizeStorePayloadOptions = {},
): Omit<DashboardTotalsSnapshot, "_id"> {
  const normalized: Omit<DashboardTotalsSnapshot, "_id"> = {
    userId: payload.userId,
    totalMemories: clampCount(payload.totalMemories),
    activeMemories: clampCount(payload.activeMemories),
    archivedMemories: clampCount(payload.archivedMemories),
    totalMessages: clampCount(payload.totalMessages),
    totalStrength: clampStrengthSum(payload.totalStrength),
    activeRecallCount: clampCount(payload.activeRecallCount),
    activeRecalledMemories: clampCount(payload.activeRecalledMemories),
    knowledgeBaseMemories: clampCount(payload.knowledgeBaseMemories),
    activeMemoriesByStore: {
      ...ZERO_COUNTS,
      ...payload.activeMemoriesByStore,
    },
    activeStoreCount: clampCount(payload.activeStoreCount),
    lastCaptureMemoryId: payload.lastCaptureMemoryId,
    lastCaptureStore: payload.lastCaptureStore,
    lastCaptureTitle: payload.lastCaptureTitle,
    lastCaptureCreatedAt: payload.lastCaptureCreatedAt,
    updatedAt: Date.now(),
  };

  if (options.omitRecallAggregate) {
    delete (normalized as Partial<DashboardTotalsSnapshot>).activeRecallCount;
    delete (normalized as Partial<DashboardTotalsSnapshot>).activeRecalledMemories;
  }

  return normalized;
}

async function getLatestStoredTotalsRow(ctx: any, userId: string): Promise<any | null> {
  const rows = await ctx.db
    .query("crystalDashboardTotals")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();

  if (rows.length === 0) return null;

  const sorted = rows.sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return sorted[0];
}

async function getStoredTotals(ctx: any, userId: string): Promise<DashboardTotalsSnapshot | null> {
  const row = await getLatestStoredTotalsRow(ctx, userId);
  return row ? normalizeTotals(row) : null;
}

/**
 * The single writer for `crystalDashboardTotals`. Every field lands through
 * `normalizeStorePayload`, so adding a counter to the snapshot type is enough to
 * make every writer persist it.
 *
 * Exported for repair paths in other modules (the weekly drift check in
 * evalStats). Do NOT hand-build a payload and `ctx.db.patch` this table: patch is
 * a shallow merge, so an omitted counter silently keeps its drifted value next to
 * the freshly recomputed ones, and the row stays self-inconsistent forever.
 */
export async function writeTotals(
  ctx: any,
  userId: string,
  snapshot: DashboardTotalsSnapshot,
  options: NormalizeStorePayloadOptions = {},
): Promise<void> {
  const current = await getLatestStoredTotalsRow(ctx, userId);
  const normalized = normalizeStorePayload(snapshot, options);

  if (current?._id) {
    await ctx.db.patch(current._id, normalized);
    return;
  }

  await ctx.db.insert("crystalDashboardTotals", normalized);
}

export async function applyDashboardTotalsDelta(ctx: any, userId: string, delta: DashboardTotalsDelta): Promise<void> {
  const currentRow = await getLatestStoredTotalsRow(ctx, userId);
  const current = currentRow ? normalizeTotals(currentRow) : newEmptyTotals(userId);
  const next = applyDelta(current, delta);
  await writeTotals(ctx, userId, next, {
    omitRecallAggregate: Boolean(currentRow && !hasStoredRecallAggregate(currentRow)),
  });
}

/**
 * ILL-179 — a memory counts toward `knowledgeBaseMemories` when it carries a
 * knowledge-base association. Accepts whatever `crystalMemories.knowledgeBaseId`
 * holds (a Convex Id, a string, null or undefined) so call sites can forward the
 * field verbatim without narrowing it.
 */
function isKnowledgeBaseMemory(knowledgeBaseId: unknown): boolean {
  if (knowledgeBaseId === undefined || knowledgeBaseId === null) return false;
  if (typeof knowledgeBaseId === "string") return knowledgeBaseId.trim().length > 0;
  return true;
}

export function buildMemoryCreateDelta(args: {
  store: string;
  archived: boolean;
  title: string;
  memoryId: string;
  createdAt: number;
  strength?: number;
  accessCount?: number;
  /** ILL-179 — pass `memory.knowledgeBaseId` for knowledge-base chunks. */
  knowledgeBaseId?: unknown;
}): DashboardTotalsDelta {
  const store = normalizeStore(args.store);
  const byStoreDelta: Partial<Record<MemoryStore, number>> = {};
  if (store && !args.archived) {
    byStoreDelta[store] = 1;
  }

  const delta: DashboardTotalsDelta = {
    totalMemoriesDelta: 1,
    activeMemoriesDelta: args.archived ? 0 : 1,
    archivedMemoriesDelta: args.archived ? 1 : 0,
    // M7 — sum strength across all (active+archived) memories.
    totalStrengthDelta: typeof args.strength === "number" ? args.strength : 0,
    // ILL-179 — mirrors activeMemoriesDelta for KB chunks only.
    knowledgeBaseMemoriesDelta: !args.archived && isKnowledgeBaseMemory(args.knowledgeBaseId) ? 1 : 0,
    activeMemoriesByStoreDelta: byStoreDelta,
    lastCaptureMemoryId: args.memoryId,
    lastCaptureStore: store,
    lastCaptureTitle: args.title,
    lastCaptureCreatedAt: args.createdAt,
  };
  const accessCount = clampCount(args.accessCount ?? 0);
  if (!args.archived && accessCount > 0) {
    delta.activeRecallCountDelta = accessCount;
    delta.activeRecalledMemoriesDelta = 1;
  }

  return delta;
}

/**
 * M7 — Returns the dashboard delta for a strength patch.
 *
 * Semantics: totalStrength tracks the sum of memory.strength values. A patch
 * that flips strength from `oldStrength` to `newStrength` produces a delta of
 * `newStrength - oldStrength`. Treats `undefined` as 0 so a freshly-set
 * strength counts as the full new value.
 */
export function buildStrengthDelta(
  oldStrength: number | undefined,
  newStrength: number | undefined,
): DashboardTotalsDelta {
  const prev = typeof oldStrength === "number" ? oldStrength : 0;
  const next = typeof newStrength === "number" ? newStrength : 0;
  return { totalStrengthDelta: next - prev };
}

export function buildMemoryTransitionDelta(args: {
  [key: string]: unknown;
  oldArchived: boolean;
  oldStore: string;
  oldAccessCount?: number;
  newArchived: boolean;
  newStore: string;
  newAccessCount?: number;
  /** ILL-179 — pass `memory.knowledgeBaseId` as it was before the patch. */
  oldKnowledgeBaseId?: unknown;
  /** ILL-179 — defaults to `oldKnowledgeBaseId`; only differs if a patch re-homes the row. */
  newKnowledgeBaseId?: unknown;
}): DashboardTotalsDelta {
  const oldStore = normalizeStore(args.oldStore);
  const newStore = normalizeStore(args.newStore);
  const byStoreDelta: Partial<Record<MemoryStore, number>> = {};

  if (!args.oldArchived && !args.newArchived && oldStore && newStore && oldStore !== newStore) {
    byStoreDelta[oldStore] = (byStoreDelta[oldStore] ?? 0) - 1;
    byStoreDelta[newStore] = (byStoreDelta[newStore] ?? 0) + 1;
  } else if (args.oldArchived && !args.newArchived) {
    if (newStore) {
      byStoreDelta[newStore] = (byStoreDelta[newStore] ?? 0) + 1;
    }
  } else if (!args.oldArchived && args.newArchived) {
    if (oldStore) {
      byStoreDelta[oldStore] = (byStoreDelta[oldStore] ?? 0) - 1;
    }
  }

  const delta: DashboardTotalsDelta = {
    activeMemoriesDelta: !args.oldArchived && args.newArchived ? -1 : args.oldArchived && !args.newArchived ? 1 : 0,
    archivedMemoriesDelta:
      args.oldArchived && !args.newArchived ? -1 : !args.oldArchived && args.newArchived ? 1 : 0,
    totalMemoriesDelta: 0,
    activeMemoriesByStoreDelta: byStoreDelta,
  };
  const oldAccessCount = clampCount(args.oldAccessCount ?? 0);
  const newAccessCount = clampCount(args.newAccessCount ?? oldAccessCount);
  const oldActive = !args.oldArchived;
  const newActive = !args.newArchived;
  const recallCountDelta = (newActive ? newAccessCount : 0) - (oldActive ? oldAccessCount : 0);
  const recalledMemoryDelta =
    (newActive && newAccessCount > 0 ? 1 : 0) - (oldActive && oldAccessCount > 0 ? 1 : 0);
  if (recallCountDelta !== 0) {
    delta.activeRecallCountDelta = recallCountDelta;
  }
  if (recalledMemoryDelta !== 0) {
    delta.activeRecalledMemoriesDelta = recalledMemoryDelta;
  }

  // ILL-179 — same shape as the recall aggregate: the KB counter tracks the
  // ACTIVE KB population, so it moves on archive/unarchive and on the (rare)
  // case of a patch adding or clearing the knowledge-base association.
  const oldIsKb = isKnowledgeBaseMemory(args.oldKnowledgeBaseId);
  const newIsKb = isKnowledgeBaseMemory(
    args.newKnowledgeBaseId === undefined ? args.oldKnowledgeBaseId : args.newKnowledgeBaseId,
  );
  const knowledgeBaseMemoriesDelta =
    (newActive && newIsKb ? 1 : 0) - (oldActive && oldIsKb ? 1 : 0);
  if (knowledgeBaseMemoriesDelta !== 0) {
    delta.knowledgeBaseMemoriesDelta = knowledgeBaseMemoriesDelta;
  }

  return delta;
}

export function buildMemoryDeleteDelta(args: {
  archived: boolean;
  store: string;
  accessCount?: number;
  strength?: number;
  /** ILL-179 — pass `memory.knowledgeBaseId` for knowledge-base chunks. */
  knowledgeBaseId?: unknown;
}): DashboardTotalsDelta {
  const store = normalizeStore(args.store);
  const delta: DashboardTotalsDelta = {
    totalMemoriesDelta: -1,
    totalStrengthDelta: typeof args.strength === "number" ? -args.strength : 0,
    activeMemoriesDelta: args.archived ? 0 : -1,
    archivedMemoriesDelta: args.archived ? -1 : 0,
    // ILL-179 — an already-archived row was removed from the KB count at archive
    // time, so only deleting a live KB chunk moves the counter.
    knowledgeBaseMemoriesDelta:
      !args.archived && isKnowledgeBaseMemory(args.knowledgeBaseId) ? -1 : 0,
  };

  if (!args.archived) {
    if (store) {
      delta.activeMemoriesByStoreDelta = { [store]: -1 };
    }

    const accessCount = clampCount(args.accessCount ?? 0);
    if (accessCount > 0) {
      delta.activeRecallCountDelta = -accessCount;
      delta.activeRecalledMemoriesDelta = -1;
    }

  }

  return delta;
}

export async function getDashboardTotals(ctx: any, userId: string): Promise<DashboardTotalsSnapshot> {
  let stored: DashboardTotalsSnapshot | null = null;
  try {
    stored = await getStoredTotals(ctx, userId);
  } catch (_error) {
    // If the aggregate table is unavailable (e.g., before backfill or during rollout),
    // compute the totals from source data directly to keep dashboard queries available.
    stored = null;
  }

  if (stored) return stored;

  const empty = newEmptyTotals(userId);
  empty.updatedAt = 0;
  return empty;
}

/**
 * ILL-179 — the single accessor for "how many memories count toward the Memory
 * Allowance". Knowledge-base chunks are imported reference material, not
 * conversational memory, so they are excluded here rather than by every caller
 * subtracting inline. ILL-183's Forgetting pass measures pressure against this
 * number; scattering the subtraction is how the two populations get conflated
 * again.
 *
 * Reads the stored aggregate only — no scan of `crystalMemories`. If the stored
 * state implies a negative result (KB count drifted above the active count, as
 * on account nd79q4vp… before repair) it is clamped to 0 and logged rather than
 * returned negative.
 */
/**
 * ILL-179 / ILL-183 — Memory Allowance and usage warnings measure this number,
 * not `activeMemories` and not `totalMemories`. KB chunks are outside the
 * allowance; archived rows have already left it.
 */
export function nonKbActiveFromTotals(totals: {
  activeMemories?: number;
  knowledgeBaseMemories?: number;
} | null | undefined): number {
  const activeMemories = clampCount(totals?.activeMemories);
  const knowledgeBaseMemories = clampCount(totals?.knowledgeBaseMemories);
  return Math.max(0, activeMemories - knowledgeBaseMemories);
}

export async function getNonKbActiveMemories(ctx: any, userId: string): Promise<number> {
  const totals = await getDashboardTotals(ctx, userId);
  const activeMemories = clampCount(totals.activeMemories);
  const knowledgeBaseMemories = clampCount(totals.knowledgeBaseMemories);
  const nonKb = nonKbActiveFromTotals(totals);
  if (activeMemories - knowledgeBaseMemories < 0) {
    console.warn(
      `[dashboardTotals] knowledgeBaseMemories (${knowledgeBaseMemories}) exceeds activeMemories ` +
        `(${activeMemories}); clamping non-KB active memories to 0. Re-run the dashboard totals backfill.`,
    );
  }
  return nonKb;
}

const BACKFILL_PAGE_SIZE = 150;
const BACKFILL_MAX_BYTES = 4_000_000;

function hydrateTotalsFromMemory(totals: DashboardTotalsSnapshot, memory: any): void {
  totals.totalMemories += 1;
  if (typeof memory.strength === "number") {
    totals.totalStrength += memory.strength;
  }

  if (memory.archived) {
    totals.archivedMemories += 1;
    return;
  }

  totals.activeMemories += 1;
  // ILL-179 — computed absolutely from the row itself, so re-running the
  // backfill is idempotent and repairs any incremental drift. Shares the
  // predicate with the delta builders so the absolute recompute and the
  // incremental path can never disagree about what counts as a KB row.
  if (isKnowledgeBaseMemory(memory.knowledgeBaseId)) {
    totals.knowledgeBaseMemories += 1;
  }
  totals.activeRecallCount += clampCount(memory.accessCount ?? 0);
  if (clampCount(memory.accessCount ?? 0) > 0) {
    totals.activeRecalledMemories += 1;
  }
  if (memory.store in totals.activeMemoriesByStore) {
    totals.activeMemoriesByStore[memory.store as MemoryStore] = clampCount(
      (totals.activeMemoriesByStore[memory.store as MemoryStore] || 0) + 1,
    );
  }

  if (
    memory.createdAt !== undefined &&
    (totals.lastCaptureCreatedAt === undefined || memory.createdAt > (totals.lastCaptureCreatedAt ?? Number.NEGATIVE_INFINITY))
  ) {
    totals.lastCaptureCreatedAt = memory.createdAt;
    totals.lastCaptureMemoryId = memory._id;
    totals.lastCaptureStore = normalizeStore(memory.store);
    totals.lastCaptureTitle = memory.title;
  }
}

function getBackfillAccumulator(args: any, userId: string): DashboardTotalsSnapshot {
  return {
    userId,
    totalMemories: clampCount(args.totalMemories ?? 0),
    activeMemories: clampCount(args.activeMemories ?? 0),
    archivedMemories: clampCount(args.archivedMemories ?? 0),
    totalMessages: clampCount(args.totalMessages ?? 0),
    totalStrength: clampStrengthSum(args.totalStrength ?? 0),
    activeRecallCount: clampCount(args.activeRecallCount ?? 0),
    activeRecalledMemories: clampCount(args.activeRecalledMemories ?? 0),
    knowledgeBaseMemories: clampCount(args.knowledgeBaseMemories ?? 0),
    activeMemoriesByStore: {
      sensory: clampCount(args.activeSensory ?? 0),
      episodic: clampCount(args.activeEpisodic ?? 0),
      semantic: clampCount(args.activeSemantic ?? 0),
      procedural: clampCount(args.activeProcedural ?? 0),
      prospective: clampCount(args.activeProspective ?? 0),
    },
    activeStoreCount: 0,
    lastCaptureMemoryId: args.lastCaptureMemoryId,
    lastCaptureStore: normalizeStore(args.lastCaptureStore ?? ""),
    lastCaptureTitle: args.lastCaptureTitle,
    lastCaptureCreatedAt: args.lastCaptureCreatedAt,
    updatedAt: Date.now(),
  };
}
