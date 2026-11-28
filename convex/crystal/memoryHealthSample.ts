/**
 * ILL-1177: the Memory health "sample" step. A fixed number of random seeks
 * into one account's memories, whatever the account size, then the ltmHygiene
 * checks on that sample: exact twins by contentHash, near twins through
 * ltmHygiene's one-search-per-execution vector action, and fluffKindForMemory.
 * It also picks the self-probe targets. Ids and counts only leave this file.
 */
import { v } from "convex/values";
import { internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agentStampKey } from "./agentStamp";
import { fluffKindForMemory } from "./ltmHygiene";
import type { MemoryHealthMetrics, MemoryHealthWork } from "./memoryHealthModel";
import { POSITIVE_PROBES, probeQueryFromTitle, searchSkipReason } from "./memoryHealthProbe";
import { COST_UNIT_BYTES } from "./recallBudgetPolicy";

export const SAMPLE_SEEKS = 60;
const SEEK_BATCH = 10;
/** Rows read per seek. The first active non-KB row is the sample. */
const SEEK_TAKE = 4;
export const NEAR_SEARCHES = 20;
const NEAR_THRESHOLD = 0.95;
const NEAR_NEIGHBORS = 8;
const NEAR_CONCURRENCY = 4;

type Work = MemoryHealthWork;
type StepInput = { snapshotId: Id<"crystalMemoryHealthSnapshots">; userId: string; startedAt: number; dayKey: string };
type StepOutput = { metrics: MemoryHealthMetrics; probeTargets?: Id<"crystalMemories">[] };

/** Approximate stored size of a document, for the snapshot's own cost record. */
export function approxDocBytes(doc: unknown): number {
  try {
    return JSON.stringify(doc)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Deterministic PRNG so a snapshot's sample can be reproduced from its id. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


export const readCreatedBounds = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const first = await ctx.db.query("crystalMemories").withIndex("by_user_created", (q) => q.eq("userId", userId)).first();
    const last = await ctx.db.query("crystalMemories").withIndex("by_user_created", (q) => q.eq("userId", userId)).order("desc").first();
    return {
      min: first?.createdAt ?? null,
      max: last?.createdAt ?? null,
      docsRead: (first ? 1 : 0) + (last ? 1 : 0),
      bytesRead: approxDocBytes(first) + approxDocBytes(last),
    };
  },
});

const sampledRow = v.object({
  id: v.id("crystalMemories"),
  channel: v.optional(v.string()),
  contentHash: v.optional(v.string()),
  stampKey: v.union(v.string(), v.null()),
  fluff: v.boolean(),
  probeable: v.boolean(),
});
type SampledRow = { id: Id<"crystalMemories">; channel?: string; contentHash?: string; stampKey: string | null; fluff: boolean; probeable: boolean };

/** One seek per point: the first active non-KB memory created at or after it. */
export const sampleMemoryBatch = internalQuery({
  args: { userId: v.string(), points: v.array(v.number()), now: v.number() },
  handler: async (ctx, { userId, points, now }) => {
    const rows: SampledRow[] = [];
    let docsRead = 0;
    let bytesRead = 0;
    for (const at of points.slice(0, SEEK_BATCH)) {
      const docs = await ctx.db
        .query("crystalMemories")
        .withIndex("by_user_created", (q) => q.eq("userId", userId).gte("createdAt", at))
        .take(SEEK_TAKE);
      docsRead += docs.length;
      bytesRead += approxDocBytes(docs);
      const hit = docs.find((doc) => !doc.archived && !doc.knowledgeBaseId);
      if (!hit) continue;
      rows.push({
        id: hit._id,
        ...(hit.channel !== undefined ? { channel: hit.channel } : {}),
        ...(hit.contentHash ? { contentHash: hit.contentHash } : {}),
        stampKey: agentStampKey(hit.metadata),
        fluff: fluffKindForMemory(hit, now) !== null,
        probeable: probeQueryFromTitle(hit.title) !== null,
      });
    }
    return { rows, docsRead, bytesRead };
  },
});

/** Ids of sampled rows that have another active non-KB row with the same contentHash, channel and agent stamp. */
export const findExactTwins = internalQuery({
  args: { userId: v.string(), rows: v.array(sampledRow) },
  handler: async (ctx, { userId, rows }) => {
    const twins: Id<"crystalMemories">[] = [];
    let docsRead = 0;
    let bytesRead = 0;
    for (const row of rows.slice(0, SEEK_BATCH * 2)) {
      if (!row.contentHash) continue;
      const docs = await ctx.db
        .query("crystalMemories")
        .withIndex("by_user_content_hash_channel", (q) =>
          q.eq("userId", userId).eq("contentHash", row.contentHash).eq("channel", row.channel).eq("archived", false))
        .take(3);
      docsRead += docs.length;
      bytesRead += approxDocBytes(docs);
      if (docs.some((doc) => doc._id !== row.id && !doc.knowledgeBaseId && agentStampKey(doc.metadata) === row.stampKey)) twins.push(row.id);
    }
    return { twins, docsRead, bytesRead };
  },
});

/** Owner-checked scope of near-duplicate neighbours. */
export const readNeighborScopes = internalQuery({
  args: { userId: v.string(), ids: v.array(v.id("crystalMemories")) },
  handler: async (ctx, { userId, ids }) => {
    const scopes: Array<{ id: Id<"crystalMemories">; channel?: string; stampKey: string | null }> = [];
    let bytesRead = 0;
    for (const id of ids.slice(0, NEAR_SEARCHES * NEAR_NEIGHBORS)) {
      const doc = await ctx.db.get(id);
      bytesRead += approxDocBytes(doc);
      if (!doc || doc.userId !== userId || doc.archived || doc.knowledgeBaseId) continue;
      scopes.push({ id, ...(doc.channel !== undefined ? { channel: doc.channel } : {}), stampKey: agentStampKey(doc.metadata) });
    }
    return { scopes, docsRead: ids.length, bytesRead };
  },
});

export async function sampleStep(ctx: ActionCtx, input: StepInput, work: Work): Promise<StepOutput> {
  const bounds = await ctx.runQuery(internal.crystal.memoryHealthSample.readCreatedBounds, { userId: input.userId });
  work.docsRead += bounds.docsRead;
  work.bytesRead += bounds.bytesRead;
  if (bounds.min === null || bounds.max === null) {
    return { metrics: { sample: { sampled: 0, hashed: 0, exactDuplicates: 0, nearSearched: 0, nearDuplicates: 0, fluff: 0 } }, probeTargets: [] };
  }
  const random = seededRandom(String(input.snapshotId));
  const span = Math.max(bounds.max - bounds.min, 0);
  const points = Array.from({ length: SAMPLE_SEEKS }, () => Math.floor(bounds.min! + random() * (span + 1)));
  const byId = new Map<string, SampledRow>();
  const before = { docs: work.docsRead, bytes: work.bytesRead };
  for (let offset = 0; offset < points.length; offset += SEEK_BATCH) {
    const batch = await ctx.runQuery(internal.crystal.memoryHealthSample.sampleMemoryBatch, {
      userId: input.userId,
      points: points.slice(offset, offset + SEEK_BATCH),
      now: input.startedAt,
    });
    work.docsRead += batch.docsRead;
    work.bytesRead += batch.bytesRead;
    for (const row of batch.rows) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const rows = [...byId.values()];
  const seekDocs = work.docsRead - before.docs;
  const avgDocBytes = seekDocs > 0 ? (work.bytesRead - before.bytes) / seekDocs : 0;

  const twinIds = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += SEEK_BATCH * 2) {
    const result = await ctx.runQuery(internal.crystal.memoryHealthSample.findExactTwins, {
      userId: input.userId,
      rows: rows.slice(offset, offset + SEEK_BATCH * 2),
    });
    work.docsRead += result.docsRead;
    work.bytesRead += result.bytesRead;
    for (const id of result.twins) twinIds.add(id);
  }

  const nearRows = rows.filter((row) => !twinIds.has(row.id)).slice(0, NEAR_SEARCHES);
  let near = { searched: 0, twins: 0 };
  let nearSkippedReason = nearRows.length ? await searchSkipReason(ctx, input, work, ["cleanup"]) : null;
  if (nearRows.length && !nearSkippedReason) {
    // Near searches are recorded on the breaker's cleanup surface, not the tenant's recall envelope.
    const debit = await ctx.runMutation(internal.crystal.costBreaker.debitUserAndGlobal, {
      userId: input.userId,
      surface: "cleanup",
      estimatedVectorQueryBytes: nearRows.length * COST_UNIT_BYTES.vectorQuery,
      reason: "memoryHealth.nearDuplicates",
    });
    if (debit.user.emergency || debit.global.emergency) nearSkippedReason = "cost breaker is not ok";
    else near = await nearTwins(ctx, input.userId, nearRows, work, avgDocBytes);
  }
  return {
    metrics: {
      sample: {
        sampled: rows.length,
        hashed: rows.filter((row) => row.contentHash).length,
        exactDuplicates: twinIds.size,
        nearSearched: near.searched,
        nearDuplicates: near.twins,
        ...(nearSkippedReason ? { nearSkippedReason } : {}),
        fluff: rows.filter((row) => row.fluff).length,
      },
    },
    probeTargets: rows.filter((row) => row.probeable).slice(0, POSITIVE_PROBES).map((row) => row.id),
  };
}

/** Near twins via ltmHygiene's vector targets and one-search-per-execution action. */
async function nearTwins(ctx: ActionCtx, userId: string, rows: SampledRow[], work: Work, avgDocBytes: number) {
  if (!rows.length) return { searched: 0, twins: 0 };
  const targets: Array<{ id: string; embedding: number[] }> = await ctx.runQuery(internal.crystal.ltmHygiene.getMemoryVectorTargets, {
    memoryIds: rows.map((row) => row.id),
  });
  // getMemoryVectorTargets reads each memory and its vector side row.
  work.docsRead += rows.length + targets.length;
  work.bytesRead += Math.round(rows.length * avgDocBytes) + targets.length * approxDocBytes(targets[0]?.embedding ?? []);
  const hitsByTarget = new Map<string, string[]>();
  for (let offset = 0; offset < targets.length; offset += NEAR_CONCURRENCY) {
    const slice = targets.slice(offset, offset + NEAR_CONCURRENCY);
    const lists = await Promise.all(slice.map((target) =>
      ctx.runAction(internal.crystal.ltmHygiene.searchOneLtmNearDupNeighbor, {
        userId,
        memoryId: target.id as Id<"crystalMemories">,
        embedding: target.embedding,
        limit: NEAR_NEIGHBORS,
      })));
    work.vectorSearches += slice.length;
    slice.forEach((target, i) => {
      hitsByTarget.set(target.id, lists[i].filter((hit) => hit.score >= NEAR_THRESHOLD).map((hit) => hit.memoryId));
    });
  }
  const neighborIds = [...new Set([...hitsByTarget.values()].flat())] as Id<"crystalMemories">[];
  const scopes = new Map<string, { channel?: string; stampKey: string | null }>();
  if (neighborIds.length) {
    const read = await ctx.runQuery(internal.crystal.memoryHealthSample.readNeighborScopes, { userId, ids: neighborIds });
    work.docsRead += read.docsRead;
    work.bytesRead += read.bytesRead;
    for (const scope of read.scopes) scopes.set(scope.id, scope);
  }
  const rowById = new Map(rows.map((row) => [String(row.id), row]));
  let twins = 0;
  for (const [targetId, neighbors] of hitsByTarget) {
    const self = rowById.get(targetId);
    if (!self) continue;
    // Same channel and same agent stamp only: two clients' similar notes are not duplicates.
    if (neighbors.some((id) => {
      const scope = scopes.get(id);
      return scope !== undefined && scope.channel === self.channel && scope.stampKey === self.stampKey;
    })) twins += 1;
  }
  return { searched: targets.length, twins };
}
