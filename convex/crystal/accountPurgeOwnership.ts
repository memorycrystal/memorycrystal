import type { FilterBuilder, GenericTableInfo, OrderedQuery } from "convex/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ACCOUNT_PURGE_TABLES, type PurgeTable } from "./accountPurgeRegistry";
import {
  MAX_DELETIONS,
  MAX_IDENTIFIER_CARRIERS,
  MAX_PARENTS,
  type Parents,
  type TargetState,
} from "./accountPurgeModel";
import { sha256Hex } from "./crypto";
import { deleteMemoryVector } from "./memoryVectors";
import { deleteMemoryEmbedding } from "./memoryEmbeddingRefs";

export function withoutIds<TableInfo extends GenericTableInfo>(
  query: OrderedQuery<TableInfo>,
  ids: ReadonlySet<string>,
): OrderedQuery<TableInfo> {
  if (ids.size === 0) return query;
  return query.filter((q: FilterBuilder<GenericTableInfo>) =>
    q.and(...[...ids].map((id) => q.neq(q.field("_id"), id))),
  );
}

type Owner = {
  userId: string;
  parents: Parents;
  identifierHashes?: string[];
  rateLimitIdentifiersShared?: number;
  sharedRateLimitIds?: string[];
  peers?: { userId: string; parents: Parents }[];
};
export const normalizeIdentifier = (value: string) =>
  value.trim().toLowerCase();
export const hashIdentifier = (value: string) =>
  sha256Hex(normalizeIdentifier(value));
export async function userIdentifierHashes(
  user: { email?: string; phone?: string } | null,
) {
  const values = [user?.email, user?.phone].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return [...new Set(await Promise.all(values.map(hashIdentifier)))];
}

async function ownsParent(
  ctx: QueryCtx,
  field: string,
  key: keyof Parents,
  row: any,
  target: Owner,
  removedCredentials: ReadonlySet<string>,
) {
  const table =
    key === "sessions"
      ? "authSessions"
      : key === "accounts"
        ? "authAccounts"
        : "crystalMemories";
  if (typeof row[field] !== "string") return false;
  const id = ctx.db.normalizeId(table, row[field]);
  if (!id) return false;
  const parent = removedCredentials.has(id) ? null : await ctx.db.get(id);
  // A live parent wins over a captured id: ownership may have changed.
  return parent
    ? parent.userId === target.userId
    : target.parents[key].includes(row[field]);
}

export async function isOwned(
  ctx: QueryCtx,
  table: PurgeTable,
  row: any,
  target: Owner,
  removedCredentials: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  if (removedCredentials.has(row._id)) return false;
  if (
    table === "authRateLimits" &&
    target.identifierHashes?.includes(await hashIdentifier(row.identifier))
  ) {
    // Read the row's current identifier and live owners, not claim-time ownership.
    const identifier = normalizeIdentifier(row.identifier);
    const peers = new Set(
      (target.peers ?? [target]).map((peer) => peer.userId),
    );
    peers.add(target.userId);
    const users = await ctx.db.query("users").take(MAX_IDENTIFIER_CARRIERS + 1);
    let shared = users.length > MAX_IDENTIFIER_CARRIERS;
    for (const user of users) {
      if (
        !peers.has(user._id) &&
        [user.email, user.phone].some(
          (value) =>
            typeof value === "string" &&
            normalizeIdentifier(value) === identifier,
        )
      ) {
        shared = true;
        break;
      }
    }
    if (!shared) {
      const accounts = await withoutIds(
        ctx.db.query("authAccounts"),
        removedCredentials,
      ).take(MAX_IDENTIFIER_CARRIERS + 1);
      shared = accounts.length > MAX_IDENTIFIER_CARRIERS;
      for (const account of accounts) {
        if (
          !peers.has(account.userId) &&
          normalizeIdentifier(account.providerAccountId) === identifier
        ) {
          shared = true;
          break;
        }
      }
    }
    if (
      shared &&
      target.sharedRateLimitIds &&
      !target.sharedRateLimitIds.includes(row._id)
    ) {
      target.sharedRateLimitIds.push(row._id);
      target.rateLimitIdentifiersShared =
        (target.rateLimitIdentifiersShared ?? 0) + 1;
    }
    return !shared;
  }
  const rule = ACCOUNT_PURGE_TABLES[table].rule;
  switch (rule.kind) {
    case "exempt":
      return false;
    case "self":
      return row._id === target.userId;
    case "single":
    case "receiver":
      return row[rule.field] === target.userId;
    case "all": {
      const present = rule.fields.filter((f) => row[f] != null);
      return (
        present.length > 0 && present.every((f) => row[f] === target.userId)
      );
    }
    case "parent":
      return ownsParent(
        ctx,
        rule.field,
        rule.parent,
        row,
        target,
        removedCredentials,
      );
    case "scope":
      return row.scope === "user" && row.scopeId === target.userId;
    case "rate":
      return row.key === `acct:${target.userId}`;
    case "association":
      if (row.userId != null) return row.userId === target.userId;
      if (
        !(await ownsParent(
          ctx,
          "fromMemoryId",
          "memories",
          row,
          target,
          removedCredentials,
        ))
      )
        return false;
      for (const peer of target.peers ?? [target]) {
        if (
          await ownsParent(
            ctx,
            "toMemoryId",
            "memories",
            row,
            peer,
            removedCredentials,
          )
        )
          return true;
      }
      return false;
  }
}

export type DeletionContext = {
  ctx: MutationCtx;
  runId: Id<"crystalAccountPurgeRuns">;
  target: TargetState & Pick<Owner, "peers">;
  deleted: number;
};

const fileIndexes = [
  ["crystalAssets", "by_purge_storage", "storageKey"],
  ["crystalAssets", "by_purge_thumbnail", "thumbnailKey"],
  ["crystalAssets", "by_purge_preview", "previewKey"],
  ["crystalResearchArtifacts", "by_purge_storage", "storageId"],
] as const;

/** Shared by planning and deletion; malformed and absent legacy files are counted, not fatal. */
export async function inspectFiles(ctx: QueryCtx, table: PurgeTable, row: any) {
  const result = {
    filesSkippedInvalidKey: 0,
    filesAlreadyMissing: 0,
    present: [] as Id<"_storage">[],
  };
  if (table !== "crystalAssets" && table !== "crystalResearchArtifacts")
    return result;
  if (
    table === "crystalAssets" &&
    (row.storageProvider ?? "convex") !== "convex"
  )
    return result;
  const files =
    table === "crystalAssets"
      ? [row.storageKey, row.thumbnailKey, row.previewKey]
      : [row.storageId];
  for (const value of new Set(files.filter(Boolean))) {
    const id = ctx.db.system.normalizeId("_storage", value);
    if (!id) {
      result.filesSkippedInvalidKey++;
    } else if (!(await ctx.db.system.get(id))) {
      result.filesAlreadyMissing++;
    } else {
      result.present.push(id);
    }
  }
  return result;
}

async function deleteUnsharedFiles(
  d: DeletionContext,
  table: PurgeTable,
  row: any,
) {
  const { ctx, target } = d;
  if (table !== "crystalAssets" && table !== "crystalResearchArtifacts") return;
  if (
    table === "crystalAssets" &&
    (row.storageProvider ?? "convex") !== "convex"
  )
    throw new Error("external_file_after_claim");
  const files = await inspectFiles(ctx, table, row);
  target.filesSkippedInvalidKey += files.filesSkippedInvalidKey;
  target.filesAlreadyMissing += files.filesAlreadyMissing;
  for (const id of files.present) {
    let shared = false;
    for (const [refTable, index, field] of fileIndexes) {
      const refs = await (ctx.db.query(refTable) as any)
        .withIndex(index, (q: any) => q.eq(field, id))
        .take(2);
      // Preserve even another target's reference. Its final row can remove the
      // bytes later. The same atomic index reads protect concurrent new refs.
      if (refs.some((ref: any) => ref._id !== row._id)) shared = true;
    }
    if (!shared) await ctx.storage.delete(id);
  }
}

/** The sole document deletion sink, including deletions delegated to vector helpers. */
export async function deleteOwned(
  d: DeletionContext,
  table: PurgeTable,
  docId: string,
): Promise<boolean> {
  const { ctx, target } = d;
  const id = ctx.db.normalizeId(table, docId);
  if (!id) return false;
  const row = await ctx.db.get(id);
  if (!row || !(await isOwned(ctx, table, row, target))) return false;
  if (d.deleted >= MAX_DELETIONS) throw new Error("deletion_budget");
  await deleteUnsharedFiles(d, table, row);
  await ctx.db.delete(id);
  await ctx.db.insert("crystalAccountPurgeLog", {
    runId: d.runId,
    userId: target.userId,
    table,
    docId,
    deletedAt: Date.now(),
  });
  d.deleted++;
  target.counts[table] = (target.counts[table] ?? 0) + 1;
  const parent =
    table === "authSessions"
      ? "sessions"
      : table === "authAccounts"
        ? "accounts"
        : table === "crystalMemories"
          ? "memories"
          : null;
  if (parent && !target.parents[parent].includes(docId)) {
    if (target.parents[parent].length >= MAX_PARENTS)
      throw new Error("parent_budget");
    target.parents[parent].push(docId);
  }
  return true;
}

function vectorContext(d: DeletionContext): MutationCtx {
  const db = new Proxy(d.ctx.db, {
    get(object, property) {
      if (property === "delete")
        return async (id: string) => {
          for (const table of [
            "crystalMemoryEmbeddingRefs",
            "crystalMemoryEmbeddings",
          ] as const)
            if (d.ctx.db.normalizeId(table, id)) {
              await deleteOwned(d, table, id);
              return;
            }
          throw new Error("unexpected_vector_delete");
        };
      if (property === "patch")
        return async (id: string, patch: any) => {
          const memoryId = d.ctx.db.normalizeId("crystalMemories", id);
          const memory = memoryId ? await d.ctx.db.get(memoryId) : null;
          if (!memory || memory.userId !== d.target.userId)
            throw new Error("vector_owner_changed");
          await d.ctx.db.patch(memory._id, patch);
        };
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { ...d.ctx, db };
}

/** One memory per page leaves room for every vector/ref deletion in the budget. */
export async function deleteMemoryOwned(
  d: DeletionContext,
  memory: Doc<"crystalMemories">,
) {
  if (!(await isOwned(d.ctx, "crystalMemories", memory, d.target))) return;
  const vectors = await d.ctx.db
    .query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", (q) => q.eq("memoryId", memory._id))
    .take(2);
  if (vectors.length > 1) throw new Error("duplicate_vectors");
  const refs = await d.ctx.db
    .query("crystalMemoryEmbeddingRefs")
    .withIndex("by_memoryId", (q) => q.eq("memoryId", memory._id))
    .take(MAX_DELETIONS);
  const vectorRefs = vectors[0]
    ? await d.ctx.db
        .query("crystalMemoryEmbeddingRefs")
        .withIndex("by_embeddingId", (q) => q.eq("embeddingId", vectors[0]._id))
        .take(MAX_DELETIONS)
    : [];
  if (
    1 +
      vectors.length +
      new Set([...refs, ...vectorRefs].map((r) => r._id)).size +
      d.deleted >
    MAX_DELETIONS
  )
    throw new Error("vector_budget");
  await deleteMemoryVector(vectorContext(d), memory._id);
  // Also remove orphan refs whose vector was already absent.
  for (const ref of refs)
    await deleteOwned(d, "crystalMemoryEmbeddingRefs", ref._id);
  await deleteOwned(d, "crystalMemories", memory._id);
}

export async function deleteVectorOwned(
  d: DeletionContext,
  id: Id<"crystalMemoryEmbeddings">,
) {
  const vector = await d.ctx.db.get(id);
  if (
    !vector ||
    !(await isOwned(d.ctx, "crystalMemoryEmbeddings", vector, d.target))
  )
    return;
  const refs = await d.ctx.db
    .query("crystalMemoryEmbeddingRefs")
    .withIndex("by_embeddingId", (q) => q.eq("embeddingId", id))
    .take(MAX_DELETIONS);
  if (refs.length + 1 + d.deleted > MAX_DELETIONS)
    throw new Error("vector_budget");
  await deleteMemoryEmbedding(vectorContext(d), id);
}
