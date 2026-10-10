/** Operator-only, source-anchored online repair. No provider calls or full scans.
 * Persist inspect results and operationId before apply; advance the source cursor
 * only after each item is applied or explicitly recorded as blocked. A retry of
 * an identical request uses its atomic receipt, never a guess from dimensions.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "./crypto";
import { buildMemoryEmbeddingInput } from "./embeddingInput";
import { embedText } from "./embeddings";
import { getMemoryEffectiveText } from "./memoryText";
import {
  assertMemoryVector,
  inlineMemoryVectorsRetired,
  MEMORY_VECTOR_MODEL,
  MEMORY_VECTOR_DIMENSIONS,
} from "./memoryVectors";

const MAX_GROUP = 25;
const internalApi: any = internal;
const REEMBED_ERROR_CODES = new Set([
  "invalid_operation_id", "missing_source", "operation_id_conflict", "applied_state_changed",
  "stale_source", "stale_group", "oversized_group", "unknown_side_model", "invalid_side_dimensions",
  "nonfinite_side_vector", "divergent_group", "unknown_prepared_model", "prepared_text_mismatch",
  "prepared_vector_required", "inline_side_divergence_requires_prepared", "missing_source_after_apply",
  "missing_openrouter_key", "embedding_cap_exceeded",
]);
type Memory = Doc<"crystalMemories">;
type Side = Doc<"crystalMemoryEmbeddings">;
type ReadContext = Pick<QueryCtx, "db">;
const hash = (value: unknown) => sha256Hex(JSON.stringify(value));
function semanticSource(memory: Memory) {
  // Explicit exclusion of volatile scoring/access fields: repair must neither
  // overwrite those fields nor invalidate a preparation due to ordinary recall.
  const fields = [
    "_id",
    "userId",
    "title",
    "content",
    "summary",
    "recallText",
    "knowledgeBaseId",
    "channel",
    "scope",
    "peerScope",
    "store",
    "category",
    "archived",
    "supersedesMemoryId",
    "supersededByMemoryId",
    "embeddingSource",
    "embedding",
    "embeddingModel",
    "rawRetentionState",
    "rawContentWipedAt",
    "contentWipedAt",
    "contentTombstone",
    "chunkKind",
    "metadata",
    "sessionId",
  ] as const;
  // Reserved slots retain fingerprint format; these fields are not in today's schema.
  return fields.map((field) => [
    field,
    field === "peerScope" || field === "embeddingModel"
      ? null
      : (memory[field] ?? null),
  ]);
}
const sourceFingerprint = (memory: Memory) => hash(semanticSource(memory));
const groupFingerprint = (rows: Side[]) =>
  hash(
    rows
      .map((row) => [
        row._id,
        row.memoryId,
        row.userId ?? null,
        row.knowledgeBaseId ?? null,
        row.conversationUserId ?? null,
        row.model,
        row.dimensions,
        row.embedding,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
async function readGroup(ctx: ReadContext, memoryId: Id<"crystalMemories">) {
  return ctx.db
    .query("crystalMemoryEmbeddings")
    .withIndex("by_memoryId", (q) => q.eq("memoryId", memoryId))
    .take(MAX_GROUP + 1);
}
function validateGroup(rows: Side[], replacingPrepared = false, replacingUnknownModel = false) {
  if (rows.length > MAX_GROUP) throw new Error("oversized_group");
  for (const row of rows) {
    if (row.model !== MEMORY_VECTOR_MODEL && !replacingUnknownModel)
      throw new Error("unknown_side_model");
    if (!replacingPrepared) {
      if (row.dimensions !== MEMORY_VECTOR_DIMENSIONS)
        throw new Error("invalid_side_dimensions");
      assertMemoryVector(row.embedding);
    } else if (row.embedding.some((value: number) => !Number.isFinite(value))) {
      throw new Error("nonfinite_side_vector");
    }
  }
  if (
    rows.some(
      (row) =>
        JSON.stringify(row.embedding) !== JSON.stringify(rows[0].embedding),
    )
  ) {
    throw new Error("divergent_group");
  }
}

function safeReembedErrorCode(error: unknown): string {
  const dataCode = error instanceof ConvexError
    ? (error.data as { code?: unknown } | undefined)?.code
    : undefined;
  if (typeof dataCode === "string" && REEMBED_ERROR_CODES.has(dataCode)) return dataCode;
  const message = error instanceof Error ? error.message : "";
  return REEMBED_ERROR_CODES.has(message) ? message : "reembed_failed";
}

/** Internal source read for the re-embed action; text is never returned by the action. */
export const getMemoryForReembedding = internalQuery({
  args: { memoryId: v.id("crystalMemories") },
  handler: async (ctx, { memoryId }) => ctx.db.get(memoryId),
});

/** Re-embed a freshly inspected source without exposing its text to the operator. */
export const reembedOne = internalAction({
  args: {
    memoryId: v.id("crystalMemories"),
    operationId: v.string(),
    dryRun: v.boolean(),
    expectedSourceFingerprint: v.string(),
    expectedGroupFingerprint: v.string(),
  },
  handler: async (ctx: ActionCtx, args): Promise<any> => {
    try {
      return await executeReembedOne(ctx, args);
    } catch (error) {
      return { status: "error" as const, code: safeReembedErrorCode(error) };
    }
  },
});

async function executeReembedOne(ctx: ActionCtx, args: {
  memoryId: Id<"crystalMemories">;
  operationId: string;
  dryRun: boolean;
  expectedSourceFingerprint: string;
  expectedGroupFingerprint: string;
}): Promise<any> {
  const inspected = await ctx.runQuery(internalApi.crystal.onlineMigration.inspectIds, {
    memoryIds: [args.memoryId],
  });
  const source = inspected.items[0];
  if (
    !source ||
    !["needs_prepared", "blocked", "unembedded"].includes(source.status) ||
    source.sourceFingerprint !== args.expectedSourceFingerprint ||
    source.groupFingerprint !== args.expectedGroupFingerprint
  ) {
    return { status: "status_changed" as const };
  }

  const memory = await ctx.runQuery(internalApi.crystal.onlineMigration.getMemoryForReembedding, {
    memoryId: args.memoryId,
  }) as Memory | null;
  if (!memory) return { status: "status_changed" as const };
  const effectiveText = getMemoryEffectiveText(memory);
  if (!effectiveText.trim()) return { status: "status_changed" as const };
  const checked = (await ctx.runQuery(internalApi.crystal.onlineMigration.inspectIds, {
    memoryIds: [args.memoryId],
  })).items[0];
  if (
    !checked ||
    !["needs_prepared", "blocked", "unembedded"].includes(checked.status) ||
    checked.sourceFingerprint !== args.expectedSourceFingerprint ||
    checked.groupFingerprint !== args.expectedGroupFingerprint ||
    checked.userId !== memory.userId ||
    checked.effectiveTextHash !== (await sha256Hex(effectiveText))
  ) {
    return { status: "status_changed" as const };
  }
  if (args.dryRun) return { status: "would_embed" as const };

  const providerInput = buildMemoryEmbeddingInput(memory);
  let embedding: number[] | null;
  try {
    embedding = await embedText(providerInput, ctx, {
      userId: memory.userId,
      source: "onlineMigration.reembedOne",
    });
  } catch (error) {
    const code = error instanceof ConvexError
      ? (error.data as { code?: unknown } | undefined)?.code
      : undefined;
    if (code === "missing_openrouter_key" || code === "embedding_cap_exceeded") {
      return { status: "error" as const, code };
    }
    return { status: "error" as const, code: "embedding_failed" };
  }
  if (!Array.isArray(embedding)) {
    return { status: "error" as const, code: "embedding_failed" };
  }

  return await ctx.runMutation(internalApi.crystal.onlineMigration.applyOne, {
    memoryId: args.memoryId,
    operationId: args.operationId,
    dryRun: false,
    expectedSourceFingerprint: args.expectedSourceFingerprint,
    expectedGroupFingerprint: args.expectedGroupFingerprint,
    prepared: {
      model: MEMORY_VECTOR_MODEL,
      embedding,
      effectiveTextHash: checked.effectiveTextHash,
    },
  });
}

async function inspectSource(ctx: ReadContext, memory: Memory) {
  const rows = await readGroup(ctx, memory._id);
  let blocker: string | null = null;
  try {
    validateGroup(rows, true);
  } catch (error) {
    blocker = (error as Error).message;
  }
  const scoped = rows.every(
    (row) =>
      row.userId === memory.userId &&
      row.knowledgeBaseId === memory.knowledgeBaseId,
  );
  const valid =
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.dimensions === MEMORY_VECTOR_DIMENSIONS &&
        row.embedding.length === MEMORY_VECTOR_DIMENSIONS,
    );
  const inlineMatches =
    rows.length > 0 &&
    (JSON.stringify(memory.embedding) === JSON.stringify(rows[0].embedding) ||
      (inlineMemoryVectorsRetired() && memory.embedding === undefined));
  const conversationScopeMatches = rows.every(
    (row) =>
      row.conversationUserId ===
      (memory.knowledgeBaseId === undefined ? memory.userId : undefined),
  );
  const hasVectors = rows.length > 0 || (memory.embedding?.length ?? 0) > 0;
  const status = blocker
    ? "blocked"
    : memory.archived
      ? hasVectors
        ? "cleanup"
        : "archived_clean"
      : memory.embeddingSource === "none"
        ? hasVectors
          ? "cleanup"
          : "ineligible"
        : !hasVectors
          ? getMemoryEffectiveText(memory)
            ? "unembedded"
            : "ineligible"
          : !valid || !scoped || (memory.embedding && !inlineMatches)
            ? "needs_prepared"
            : inlineMatches && rows.length === 1 && conversationScopeMatches
              ? "ready"
              : "repairable";
  return {
    memoryId: memory._id,
    sourceFingerprint: await sourceFingerprint(memory),
    groupFingerprint: await groupFingerprint(rows),
    effectiveTextHash: await sha256Hex(getMemoryEffectiveText(memory)),
    userId: memory.userId,
    archived: memory.archived,
    inlinePresent: Array.isArray(memory.embedding),
    sideCount: rows.length,
    status,
    blocker,
  };
}

export const inspectPage = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const size = args.pageSize ?? 5;
    if (!Number.isInteger(size) || size < 1 || size > 10)
      throw new Error("pageSize must be 1..10");
    const page = await ctx.db
      .query("crystalMemories")
      .paginate({ cursor: args.cursor, numItems: size });
    const items = [];
    for (const memory of page.page) {
      items.push(await inspectSource(ctx, memory));
    }
    return { items, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Reconcile already prepared IDs without enumerating unrelated sources. */
export const inspectIds = internalQuery({
  args: { memoryIds: v.array(v.id("crystalMemories")) },
  handler: async (ctx, args) => {
    if (args.memoryIds.length > 10) throw new Error("at most 10 memoryIds");
    const items = [];
    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db.get(memoryId);
      items.push(
        memory
          ? await inspectSource(ctx, memory)
          : { memoryId, status: "blocked", blocker: "missing_source" },
      );
    }
    return { items };
  },
});

export const applyOne = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    operationId: v.string(),
    dryRun: v.boolean(),
    expectedSourceFingerprint: v.string(),
    expectedGroupFingerprint: v.string(),
    prepared: v.optional(
      v.object({
        model: v.string(),
        embedding: v.array(v.float64()),
        effectiveTextHash: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (!args.operationId.trim() || args.operationId.length > 200)
      throw new Error("invalid_operation_id");
    const requestFingerprint = await hash([
      args.memoryId,
      args.operationId,
      args.expectedSourceFingerprint,
      args.expectedGroupFingerprint,
      args.prepared
        ? [
            args.prepared.model,
            args.prepared.embedding,
            args.prepared.effectiveTextHash,
          ]
        : null,
    ]);
    const receipt = await ctx.db
      .query("crystalOnlineVectorReceipts")
      .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
      .unique();
    const memory = await ctx.db.get(args.memoryId);
    if (!memory) throw new Error("missing_source");
    const rows = await readGroup(ctx, args.memoryId);
    const currentSource = await sourceFingerprint(memory);
    const currentGroup = await groupFingerprint(rows);
    if (receipt) {
      if (
        receipt.memoryId !== args.memoryId ||
        receipt.requestFingerprint !== requestFingerprint
      )
        throw new Error("operation_id_conflict");
      if (
        receipt.resultSourceFingerprint !== currentSource ||
        receipt.resultGroupFingerprint !== currentGroup
      )
        throw new Error("applied_state_changed");
      return {
        status: "already_applied" as const,
        sourceFingerprint: currentSource,
        groupFingerprint: currentGroup,
      };
    }
    if (currentSource !== args.expectedSourceFingerprint)
      throw new Error("stale_source");
    if (currentGroup !== args.expectedGroupFingerprint)
      throw new Error("stale_group");
    const replacingPrepared = args.prepared !== undefined && !memory.archived && memory.embeddingSource !== "none";
    validateGroup(rows, replacingPrepared, replacingPrepared);
    if (args.prepared) {
      if (args.prepared.model !== MEMORY_VECTOR_MODEL)
        throw new Error("unknown_prepared_model");
      assertMemoryVector(args.prepared.embedding);
    }
    const inactive = memory.archived || memory.embeddingSource === "none";
    let embedding: number[] | undefined;
    if (!inactive) {
      if (args.prepared) {
        if (
          !getMemoryEffectiveText(memory) ||
          args.prepared.effectiveTextHash !==
            (await sha256Hex(getMemoryEffectiveText(memory)))
        )
          throw new Error("prepared_text_mismatch");
        embedding = args.prepared.embedding;
      } else {
        // Inline arrays have no historical model proof. Only a correctly scoped
        // named-model side row proves provenance for a no-spend mirror repair.
        const side = rows[0];
        if (
          !side ||
          rows.some(
            (row) =>
              row.userId !== memory.userId ||
              row.knowledgeBaseId !== memory.knowledgeBaseId,
          )
        )
          throw new Error("prepared_vector_required");
        const inline = memory.embedding;
        if (inline && JSON.stringify(inline) !== JSON.stringify(side.embedding))
          throw new Error("inline_side_divergence_requires_prepared");
        embedding = side.embedding;
      }
    }
    if (args.dryRun)
      return {
        status: "would_apply" as const,
        deleted: inactive ? rows.length : Math.max(0, rows.length - 1),
      };
    // Patch vector fields only: source text, owner, and live counters survive.
    await ctx.db.patch(memory._id, {
      embedding: inlineMemoryVectorsRetired() ? undefined : embedding,
    });
    if (inactive) {
      for (const row of rows) await ctx.db.delete(row._id);
    } else {
      const value = {
        memoryId: memory._id,
        userId: memory.userId,
        knowledgeBaseId: memory.knowledgeBaseId,
        conversationUserId:
          memory.knowledgeBaseId === undefined ? memory.userId : undefined,
        embedding: embedding!,
        model: MEMORY_VECTOR_MODEL,
        dimensions: MEMORY_VECTOR_DIMENSIONS,
        createdAt: rows[0]?.createdAt ?? Date.now(),
      };
      if (rows[0]) await ctx.db.patch(rows[0]._id, value);
      else await ctx.db.insert("crystalMemoryEmbeddings", value);
      for (const row of rows.slice(1)) await ctx.db.delete(row._id);
    }
    const updatedMemory = await ctx.db.get(memory._id);
    if (!updatedMemory) throw new Error("missing_source_after_apply");
    const resultSourceFingerprint = await sourceFingerprint(updatedMemory);
    const resultGroupFingerprint = await groupFingerprint(
      await readGroup(ctx, memory._id),
    );
    await ctx.db.insert("crystalOnlineVectorReceipts", {
      operationId: args.operationId,
      memoryId: memory._id,
      requestFingerprint,
      resultSourceFingerprint,
      resultGroupFingerprint,
      createdAt: Date.now(),
    });
    return {
      status: "applied" as const,
      sourceFingerprint: resultSourceFingerprint,
      groupFingerprint: resultGroupFingerprint,
    };
  },
});
